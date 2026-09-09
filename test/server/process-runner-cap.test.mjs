/**
 * Process runner accumulation and formatProcessOutput caps (MIN-345).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  PROCESS_MAX_ACCUMULATE_BYTES,
  resolveOutputCapPolicy,
  runWithOutputCapPolicy,
} from '../../server/tools/output-cap.js';
import {
  formatProcessOutput,
  runProcess,
  sliceStreamLines,
} from '../../server/process-runner.js';

describe('process-runner output caps', () => {
  it('formatProcessOutput truncates oversized stdout', () => {
    const stdout = 'x'.repeat(DEFAULT_MAX_OUTPUT_CHARS + 5_000);
    const formatted = formatProcessOutput('test cmd', { code: 0, stdout, stderr: '' });
    assert.match(formatted, /\[truncated — \d+ of \d+ chars;/);
    assert.ok(formatted.length < stdout.length);
  });

  it('formatProcessOutput does not slice when applyResultCap is false', () => {
    const stdout = 'x'.repeat(DEFAULT_MAX_OUTPUT_CHARS + 5_000);
    const policy = resolveOutputCapPolicy({ enabled: false, maxChars: DEFAULT_MAX_OUTPUT_CHARS }, {});
    const formatted = runWithOutputCapPolicy(policy, () =>
      formatProcessOutput('test cmd', { code: 0, stdout, stderr: '' }),
    );
    assert.doesNotMatch(formatted, /\[truncated —/);
    assert.ok(formatted.includes(stdout.slice(0, 40)));
  });

  it('formatProcessOutput notes subprocess accumulation truncation', () => {
    const formatted = formatProcessOutput('test cmd', {
      code: 0,
      stdout: 'ok',
      stderr: '',
      accumulationTruncated: true,
    });
    assert.match(formatted, /exceeded .* bytes and was cut during capture/);
  });

  it('runProcess stops accumulating stdout beyond byte ceiling', async () => {
    const limitMb = Math.ceil(PROCESS_MAX_ACCUMULATE_BYTES / (1024 * 1024)) + 1;
    const result = await runProcess('node', [
      '-e',
      `process.stdout.write('a'.repeat(${limitMb} * 1024 * 1024))`,
    ]);
    assert.equal(result.accumulationTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= PROCESS_MAX_ACCUMULATE_BYTES);
  });

  it('formatProcessOutput keeps the tail of an oversized log', () => {
    // A build log puts the failure at the end; head-only truncation loses it.
    const noise = Array.from({ length: DEFAULT_MAX_OUTPUT_CHARS / 10 }, () => 'compiling…').join(
      '\n',
    );
    const stdout = `${noise}\nFAILED: 3 tests`;
    const formatted = formatProcessOutput('npm test', { code: 1, stdout, stderr: '' });
    assert.match(formatted, /FAILED: 3 tests/);
    assert.match(formatted, /chars elided from the middle/);
  });
});

describe('command output slicing', () => {
  const log = Array.from({ length: 500 }, (_, i) => `line-${i + 1}`).join('\n');

  it('returns the text unchanged with no slice requested', () => {
    assert.equal(sliceStreamLines(log, undefined), log);
    assert.equal(sliceStreamLines(log, {}), log);
  });

  it('keeps only the requested tail', () => {
    const out = sliceStreamLines(log, { tailLines: 3 });
    assert.doesNotMatch(out, /line-1\b/);
    assert.match(out, /line-500/);
    assert.match(out, /497 lines omitted/);
  });

  it('keeps head and tail together', () => {
    const out = sliceStreamLines(log, { headLines: 2, tailLines: 2 });
    assert.match(out, /line-1\b/);
    assert.match(out, /line-500/);
    assert.match(out, /496 lines omitted/);
  });

  it('leaves short output alone', () => {
    assert.equal(sliceStreamLines('a\nb', { tailLines: 10 }), 'a\nb');
  });
});
