/**
 * Shared output-cap helpers (MIN-345).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  appendWithByteCap,
  capLineLength,
  READ_FILE_DEFAULT_LINES,
  capTextOutput,
  elideMiddle,
  renderReadFileWindow,
  resolvePerCallMaxChars,
  resolveOutputCapPolicy,
  runWithOutputCapPolicy,
} from '../../server/tools/output-cap.js';

describe('output-cap', () => {
  it('does not import node:async_hooks (shared with the Vite SPA)', () => {
    const path = fileURLToPath(new URL('../../server/tools/output-cap.js', import.meta.url));
    const source = fs.readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /async_hooks/);
  });

  it('capLineLength adds ellipsis for long lines', () => {
    const line = 'x'.repeat(500);
    const capped = capLineLength(line, 100);
    assert.equal(capped.length, 100);
    assert.match(capped, /\.\.\.$/);
  });

  it('capTextOutput truncates with metadata footer', () => {
    const text = 'a'.repeat(DEFAULT_MAX_OUTPUT_CHARS + 100);
    const { text: capped, truncated } = capTextOutput(text);
    assert.equal(truncated, true);
    assert.ok(capped.length < text.length);
    assert.match(capped, /\[truncated — \d+ of \d+ chars;/);
  });

  it('capTextOutput does not flag CRLF text under the cap as truncated', () => {
    // Dropping \r on EOL normalization must not be mistaken for dropped content —
    // this is the common case for Windows execute_command output.
    const crlf = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\r\n');
    const { text, truncated } = capTextOutput(crlf);
    assert.equal(truncated, false);
    assert.doesNotMatch(text, /\[truncated/);
  });

  it('appendWithByteCap stops at byte budget', () => {
    const chunk = 'ü'.repeat(10);
    const first = appendWithByteCap('', chunk, 4);
    assert.equal(first.truncated, true);
    assert.ok(Buffer.byteLength(first.text, 'utf8') <= 4);
  });

  it('does not slice oversized text when applyResultCap is false', () => {
    const text = 'a'.repeat(DEFAULT_MAX_OUTPUT_CHARS + 100);
    const { text: out, truncated } = capTextOutput(text, { applyResultCap: false });
    assert.equal(truncated, false);
    assert.equal(out, text);
    assert.doesNotMatch(out, /\[truncated —/);
  });

  it('truncates by default and skips the cap with full_result policy', () => {
    const text = 'a'.repeat(DEFAULT_MAX_OUTPUT_CHARS + 100);
    const { truncated: withCap } = capTextOutput(text);
    assert.equal(withCap, true);

    const policy = resolveOutputCapPolicy({ enabled: true, maxChars: DEFAULT_MAX_OUTPUT_CHARS }, {
      full_result: true,
    });
    const { text: full, truncated: skipped } = runWithOutputCapPolicy(policy, () =>
      capTextOutput(text),
    );
    assert.equal(skipped, false);
    assert.equal(full, text);
  });
});


/** Run fn under a per-call char budget, as executeServerTool does. */
function withBudget(maxOutputChars, fn) {
  return runWithOutputCapPolicy(resolveOutputCapPolicy(undefined, { max_output_chars: maxOutputChars }), fn);
}

describe('renderReadFileWindow', () => {
  const numbered = (n) => Array.from({ length: n }, (_, i) => `line-${i + 1}`).join('\n');

  it('numbers every line and ignores a trailing newline', () => {
    const { text, truncated, totalLines } = renderReadFileWindow('a\nb\n', { relPath: 'x.txt' });
    assert.equal(text, '1: a\n2: b');
    assert.equal(truncated, false);
    assert.equal(totalLines, 2);
  });

  it('returns the offset/limit window with a continuation footer', () => {
    const { text, truncated } = renderReadFileWindow(numbered(50), { relPath: 'x.txt', offset: 10, limit: 5 });
    assert.equal(truncated, true);
    assert.match(text, /^10: line-10\n/);
    assert.match(text, /14: line-14\n/);
    assert.doesNotMatch(text, /15: line-15/);
    assert.match(text, /\[lines 10-14 of 50; continue with offset=15\]/);
  });

  it('stops at the default line window', () => {
    const { text, endLine } = renderReadFileWindow(numbered(READ_FILE_DEFAULT_LINES + 10), { relPath: 'x.txt' });
    assert.equal(endLine, READ_FILE_DEFAULT_LINES);
    assert.match(text, new RegExp(`continue with offset=${READ_FILE_DEFAULT_LINES + 1}`));
  });

  it('stops at the char budget on a complete line', () => {
    const { text, truncated, endLine } = withBudget(600, () =>
      renderReadFileWindow(numbered(500), { relPath: 'big.txt' }),
    );
    assert.equal(truncated, true);
    assert.ok(endLine > 10 && endLine < 500);
    assert.match(text, new RegExp(`${endLine}: line-${endLine}\\n`));
    assert.match(text, /\[truncated — lines 1-\d+ of 500; continue with offset=\d+/);
  });

  it('bounds a single oversized line instead of returning nothing', () => {
    const { text, truncated } = withBudget(600, () =>
      renderReadFileWindow(`${'x'.repeat(5_000)}\nsecond`, { relPath: 'bundle.min.js' }),
    );
    assert.equal(truncated, true);
    assert.match(text, /^1: x+/);
    assert.match(text, /continue with offset=2/);
  });

  it('leads an oversized whole-file read with the outline', () => {
    const outline = '  1-20  function alpha()\n  21-400  class Beta';
    const { text } = withBudget(2_000, () =>
      renderReadFileWindow(numbered(500), { relPath: 'big.ts', outline }),
    );
    assert.match(text, /^\[big\.ts has 500 lines — too large for one read\. Symbol outline/);
    assert.match(text, /class Beta/);
    assert.match(text, /1: line-1\n/);
  });

  it('never uses the outline when the file fits or a window was requested', () => {
    const outline = '  1-2  function alpha()';
    assert.doesNotMatch(renderReadFileWindow(numbered(3), { relPath: 'a.ts', outline }).text, /outline/);
    const windowed = withBudget(600, () =>
      renderReadFileWindow(numbered(500), { relPath: 'a.ts', offset: 1, outline }),
    );
    assert.doesNotMatch(windowed.text, /outline/);
  });

  it('reports an offset past the end as an error', () => {
    const { text } = renderReadFileWindow(numbered(3), { relPath: 'a.ts', offset: 9 });
    assert.match(text, /^Error: offset 9 is past the end of a\.ts \(3 lines\)/);
  });

  it('returns the whole file when the cap is off', () => {
    const policy = resolveOutputCapPolicy({ enabled: false, maxChars: 80 }, {});
    const { text, truncated } = runWithOutputCapPolicy(policy, () =>
      renderReadFileWindow(numbered(READ_FILE_DEFAULT_LINES + 5), { relPath: 'big.txt' }),
    );
    assert.equal(truncated, false);
    assert.match(text, new RegExp(`${READ_FILE_DEFAULT_LINES + 5}: line-${READ_FILE_DEFAULT_LINES + 5}$`));
  });
});

describe('output-cap per-call budget and middle elision', () => {
  it('elideMiddle keeps the head and the tail', () => {
    const text = `START${'x'.repeat(5_000)}END`;
    const out = elideMiddle(text, 400);
    assert.match(out, /^START/);
    assert.match(out, /END$/);
    assert.match(out, /chars elided from the middle/);
    assert.ok(out.length < text.length);
  });

  it('elideMiddle leaves text under the budget alone', () => {
    assert.equal(elideMiddle('short', 400), 'short');
  });

  it('capTextOutput with middleElide keeps the last line of a long log', () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => `line-${i + 1}`);
    const { text, truncated } = capTextOutput(lines.join('\n'), {
      maxOutputChars: 2_000,
      middleElide: true,
    });
    assert.equal(truncated, true);
    assert.match(text, /line-1\b/);
    assert.match(text, /line-5000/);
  });

  it('max_output_chars lowers the budget but cannot raise it', () => {
    assert.equal(resolvePerCallMaxChars({ max_output_chars: 4_000 }, 128_000), 4_000);
    assert.equal(resolvePerCallMaxChars({ max_output_chars: 999_999 }, 128_000), 128_000);
    assert.equal(resolvePerCallMaxChars({ max_output_chars: 1 }, 128_000), 500);
    assert.equal(resolvePerCallMaxChars({}, 128_000), 40_000);
    assert.equal(resolvePerCallMaxChars({}, 12_000), 12_000);
    assert.equal(resolvePerCallMaxChars({ max_output_chars: 80_000 }, 128_000), 80_000);
  });

  it('resolveOutputCapPolicy honours a per-call max_output_chars', () => {
    const policy = resolveOutputCapPolicy(undefined, { max_output_chars: 900 });
    assert.equal(policy.maxOutputChars, 900);
    assert.equal(policy.applyResultCap, true);
  });
});
