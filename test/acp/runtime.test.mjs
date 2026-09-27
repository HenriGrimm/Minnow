import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { saveAcpAgent } from '../../server/acp/store.js';
import {
  cancelAcpRun,
  getAcpRun,
  shutdownAllAcpRuns,
  startAcpRun,
  validateAcpAgent,
} from '../../server/acp/runtime.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url));
let home;

async function waitForRun(id, statuses) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = getAcpRun(id);
    if (run && statuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ACP run ${id}`);
}

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-acp-runtime-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  await saveAcpAgent({
    id: 'echo-agent',
    label: 'Echo agent',
    command: process.execPath,
    args: [fixture],
  });
  await saveAcpAgent({
    id: 'secret-agent',
    label: 'Secret agent',
    command: process.execPath,
    args: [fixture, '--echo-secret'],
    secretEnv: { ACP_FIXTURE_TOKEN: 'private-value' },
  });
  await saveAcpAgent({
    id: 'oversized-agent',
    label: 'Oversized agent',
    command: process.execPath,
    args: [fixture, '--oversized-update'],
  });
  await saveAcpAgent({
    id: 'waiting-agent',
    label: 'Waiting agent',
    command: process.execPath,
    args: [fixture, '--wait-for-cancel'],
  });
});

after(async () => {
  await shutdownAllAcpRuns();
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  await fs.rm(home, { recursive: true, force: true });
});

test('validates and records a compliant ACP agent', async () => {
  const result = await validateAcpAgent('echo-agent');
  assert.equal(result.ok, true);
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.capabilities.textPrompt, true);
});

test('records streamed ACP output and completion', async () => {
  const started = await startAcpRun('echo-agent', { prompt: 'from Minnow' });
  const run = await waitForRun(started.id, ['completed', 'failed']);
  assert.equal(run.status, 'completed');
  assert.equal(run.stopReason, 'end_turn');
  assert.match(
    run.events.filter((event) => event.type === 'message').map((event) => event.text).join(''),
    /Echo: from Minnow/,
  );
});

test('cancels a running ACP prompt through session/cancel', async () => {
  const started = await startAcpRun('waiting-agent', { prompt: 'wait' });
  await waitForRun(started.id, ['running']);
  assert.equal(await cancelAcpRun(started.id), true);
  const run = await waitForRun(started.id, ['cancelled', 'failed']);
  assert.equal(run.status, 'cancelled');
  assert.ok(run.events.some((event) => event.status === 'cancelling'));
});

test('redacts registered private environment values from streamed agent output', async () => {
  const started = await startAcpRun('secret-agent', { prompt: 'echo the environment' });
  const run = await waitForRun(started.id, ['completed', 'failed']);
  const serialized = JSON.stringify(run);
  assert.doesNotMatch(serialized, /private-value/);
  assert.match(serialized, /\[redacted\]/);
});

test('bounds oversized ACP updates retained by a run', async () => {
  const started = await startAcpRun('oversized-agent', { prompt: 'large update' });
  const run = await waitForRun(started.id, ['completed', 'failed']);
  const event = run.events.find((entry) => entry.type === 'message');
  assert.equal(event?.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(event), 'utf8') < 64 * 1024);
});
