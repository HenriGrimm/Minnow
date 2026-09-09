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
  capReadFileOutput,
  capTextOutput,
  elideMiddle,
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

  it('capReadFileOutput hard-truncates a single oversized line', () => {
    // A minified bundle on one line kept zero lines before, pointing read_file_range at
    // the same oversized line; now it returns a bounded head with guidance.
    const oneLine = 'x'.repeat(500);
    const { text, truncated } = capReadFileOutput(oneLine, 'bundle.min.js', 80);
    assert.equal(truncated, true);
    assert.doesNotMatch(text, /read_file_range/);
    assert.match(text, /line 1 exceeds 80 chars/);
  });

  it('appendWithByteCap stops at byte budget', () => {
    const chunk = 'ü'.repeat(10);
    const first = appendWithByteCap('', chunk, 4);
    assert.equal(first.truncated, true);
    assert.ok(Buffer.byteLength(first.text, 'utf8') <= 4);
  });

  it('capReadFileOutput keeps complete lines and suggests read_file_range', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`);
    const content = lines.join('\n');
    const { text, truncated } = capReadFileOutput(content, 'big.txt', 80);
    assert.equal(truncated, true);
    assert.match(text, /read_file_range with path="big.txt"/);
    assert.doesNotMatch(text, /line-200/);
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

  it('capReadFileOutput skips the product cap when ALS applyResultCap is false', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`);
    const content = lines.join('\n');
    const policy = resolveOutputCapPolicy({ enabled: false, maxChars: 80 }, {});
    const { text, truncated } = runWithOutputCapPolicy(policy, () =>
      capReadFileOutput(content, 'big.txt'),
    );
    assert.equal(truncated, false);
    assert.match(text, /line-200/);
    assert.doesNotMatch(text, /\[truncated —/);
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
    assert.equal(resolvePerCallMaxChars({}, 128_000), 128_000);
  });

  it('resolveOutputCapPolicy honours a per-call max_output_chars', () => {
    const policy = resolveOutputCapPolicy(undefined, { max_output_chars: 900 });
    assert.equal(policy.maxOutputChars, 900);
    assert.equal(policy.applyResultCap, true);
  });
});
