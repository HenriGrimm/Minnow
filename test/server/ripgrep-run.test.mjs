/**
 * `runRipgrep` liveness — the thing that made a broad agent search look like a hang.
 *
 * These drive `process.execPath` rather than the real `rg`, because what is under test
 * is the supervision (kill on timeout/abort/overflow, keep what was collected), not
 * ripgrep. A child that never exits on its own is the whole point.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RG_MAX_STDOUT_BYTES,
  RG_TIMEOUT_MS,
  runRipgrep,
} from '../../server/lib/ripgrep-run.js';

/** A child that prints forever and never exits. */
const FOREVER = ['-e', "setInterval(() => process.stdout.write('x'.repeat(8 * 1024)), 1)"];

describe('runRipgrep supervision', () => {
  it('returns output and exit code when the child ends on its own', async () => {
    const run = await runRipgrep(process.execPath, [
      '-e',
      "process.stdout.write('a.ts:1:hit\\n'); process.exit(1)",
    ]);
    assert.equal(run.stopped, null);
    assert.equal(run.code, 1);
    assert.equal(run.stdout, 'a.ts:1:hit\n');
  });

  it('kills a child that outruns the timeout and keeps what it collected', async () => {
    const started = Date.now();
    const run = await runRipgrep(process.execPath, FOREVER, { timeoutMs: 300 });

    assert.equal(run.stopped, 'timeout');
    assert.ok(run.stdout.length > 0, 'partial output must survive the kill');
    // The point of the fix: the call ends at its own ceiling, nowhere near the turn's
    // five-minute backstop, and the process is dead rather than abandoned.
    assert.ok(Date.now() - started < 5_000, 'must settle at its own ceiling');
  });

  it('kills a child on abort', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const run = await runRipgrep(process.execPath, FOREVER, {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    assert.equal(run.stopped, 'aborted');
  });

  it('does not start a child for an already-aborted signal', async () => {
    const run = await runRipgrep(process.execPath, FOREVER, {
      signal: AbortSignal.abort(),
    });
    assert.equal(run.stopped, 'aborted');
  });

  it('stops at the output ceiling instead of rejecting, and keeps the bytes', async () => {
    const maxBytes = 256 * 1024;
    const run = await runRipgrep(process.execPath, FOREVER, { maxBytes });

    assert.equal(run.stopped, 'overflow');
    // `execFile`'s maxBuffer threw this away and reported an error instead.
    assert.ok(run.stdout.length >= maxBytes, 'collected output must be returned');
  });

  it('rejects only when the executable cannot be spawned', async () => {
    await assert.rejects(() =>
      runRipgrep('definitely-not-a-real-binary-xyz', ['--files'], { timeoutMs: 2_000 }),
    );
  });

  it('keeps its ceilings below the turn backstop', async () => {
    const { DEFAULT_TOOL_TIMEOUT_MS } = await import('../../server/runner/tool-timeouts.js');
    assert.ok(
      RG_TIMEOUT_MS < DEFAULT_TOOL_TIMEOUT_MS,
      'a search must never be what reaches the turn backstop',
    );
    assert.ok(RG_MAX_STDOUT_BYTES > 0);
  });
});
