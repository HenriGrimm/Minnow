/**
 * A blocking in-app execute_command streams through the terminal panel instead of
 * the server tool handler, and its args are forwarded by hand. Result-size knobs
 * that are documented in the schema but dropped here do nothing on the path the
 * model actually uses — while the truncation footer keeps advertising them.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveStreamingCommandOptions } from '../../src/tools/streaming-command-options.ts';

describe('resolveStreamingCommandOptions', () => {
  test('forwards every result-size knob execute_command advertises', () => {
    const options = resolveStreamingCommandOptions('execute_command', {
      command: 'npm test',
      max_output_chars: 3000,
      head_lines: 5,
      tail_lines: 3,
    });

    assert.equal(options.maxOutputChars, 3000);
    assert.deepEqual(options.outputSlice, { headLines: 5, tailLines: 3 });
  });

  test('omits the knobs when the model did not ask for them', () => {
    const options = resolveStreamingCommandOptions('execute_command', { command: 'ls' });
    assert.equal('maxOutputChars' in options, false);
    assert.equal('outputSlice' in options, false);
    assert.equal(options.fullResult, false);
    assert.equal(options.allowUnsandboxed, false);
  });

  test('accepts head_lines and tail_lines independently', () => {
    assert.deepEqual(
      resolveStreamingCommandOptions('execute_command', { tail_lines: 20 }).outputSlice,
      { tailLines: 20 },
    );
    assert.deepEqual(
      resolveStreamingCommandOptions('execute_command', { head_lines: 4 }).outputSlice,
      { headLines: 4 },
    );
  });

  test('ignores non-positive and non-numeric line counts', () => {
    const options = resolveStreamingCommandOptions('execute_command', {
      head_lines: 0,
      tail_lines: -3,
      max_output_chars: 'lots',
    });
    assert.equal('outputSlice' in options, false);
    assert.equal('maxOutputChars' in options, false);
  });

  test('carries cwd, timeout, sandbox, and full_result through', () => {
    const options = resolveStreamingCommandOptions('execute_command', {
      cwd: '  sub/dir  ',
      timeout_ms: 90_000,
      allow_unsandboxed: true,
      full_result: true,
    });
    assert.equal(options.cwd, 'sub/dir');
    assert.equal(options.timeoutMs, 90_000);
    assert.equal(options.allowUnsandboxed, true);
    assert.equal(options.fullResult, true);
  });

  test('run_javascript and run_python take the knobs but not cwd or timeout', () => {
    const options = resolveStreamingCommandOptions('run_javascript', {
      code: 'console.log(1)',
      cwd: 'ignored',
      timeout_ms: 5_000,
      tail_lines: 2,
    });
    assert.equal('cwd' in options, false);
    assert.equal('timeoutMs' in options, false);
    assert.deepEqual(options.outputSlice, { tailLines: 2 });
  });

  test('accepts `full` as an alias for full_result', () => {
    assert.equal(resolveStreamingCommandOptions('execute_command', { full: true }).fullResult, true);
  });
});
