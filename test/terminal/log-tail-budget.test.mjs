import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  createRun, getRun, readCommandLogSnapshot, stopActiveRun, waitForRun, __evictForTests,
} from '../../server/terminal-runner.js';

let home;
const oldHome = process.env.MINNOW_HOME;
before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-log-tail-budget-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
});
after(async () => {
  if (oldHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = oldHome;
  resetMinnowHomeCache();
  await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('live, finished, and evicted command logs honor the requested UTF-8 byte budget', async () => {
  const { runId } = await createRun({
    command: process.execPath,
    args: ['-e', "process.stdout.write('🌊'.repeat(20000)+'END'); setInterval(()=>{},1000)"],
    cwd: process.cwd(), shell: false, timeoutMs: 10000,
  });
  try {
    const logPath = getRun(runId).logPath;
    // Wait for the child's output to reach the actual log file.
    for (let n = 0; n < 100; n++) {
      if ((await fs.readFile(logPath, 'utf8').catch(() => '')).endsWith('END')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok((await fs.readFile(logPath, 'utf8')).endsWith('END'));
    async function checkTail(finished) {
      for (const bytes of [8, 1024, 5000]) {
        const snapshot = await readCommandLogSnapshot(runId, bytes);
        assert.equal(snapshot.finished, finished);
        assert.ok(Buffer.byteLength(snapshot.output) <= bytes);
        assert.ok(snapshot.output.endsWith('END'));
        assert.ok(!snapshot.output.includes('�'));
      }
    }
    await checkTail(false);
    await stopActiveRun(runId);
    await checkTail(true);
    // A missing log file falls back to memory, under the same byte ceiling.
    await fs.unlink(logPath);
    await checkTail(true);
    // Disk output may be newer than a capped in-memory buffer.
    await fs.writeFile(logPath, 'newer output\nEND');
    assert.equal((await readCommandLogSnapshot(runId, 1024)).output, 'newer output\nEND');
    __evictForTests(runId);
    await checkTail(true);
  } finally {
    await stopActiveRun(runId);
  }
});

test('the latest file tail wins after command output exceeds the memory cap', async () => {
  const { runId } = await createRun({
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(3*1024*1024)+'LATEST-END')"],
    cwd: process.cwd(), shell: false,
  });
  await waitForRun(runId);
  const snapshot = await readCommandLogSnapshot(runId, 1024);
  assert.ok(Buffer.byteLength(snapshot.output) <= 1024);
  assert.ok(snapshot.output.endsWith('LATEST-END'));
});
