import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  getAcpAgentRuntime,
  listAcpAgents,
  saveAcpAgent,
} from '../../server/acp/store.js';

let home;

before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-acp-store-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
});

after(async () => {
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  await fs.rm(home, { recursive: true, force: true });
});

test('ACP registration keeps private environment encrypted and redacted from public rows', async () => {
  const saved = await saveAcpAgent({
    id: 'fixture-agent',
    label: 'Fixture agent',
    command: process.execPath,
    args: ['fixture.mjs'],
    secretEnv: { ACP_TOKEN: 'top-secret' },
  });
  assert.deepEqual(saved.envKeys, ['ACP_TOKEN']);
  assert.equal(saved.hasPrivateEnvironment, true);
  assert.equal(JSON.stringify(saved).includes('top-secret'), false);

  const [listed] = await listAcpAgents();
  assert.equal(JSON.stringify(listed).includes('top-secret'), false);
  const runtime = await getAcpAgentRuntime('fixture-agent');
  assert.equal(runtime.secrets.env.ACP_TOKEN, 'top-secret');

  const raw = await fs.readFile(
    path.join(home, 'acp', 'agents', 'fixture-agent', 'secrets.json'),
    'utf8',
  );
  assert.doesNotMatch(raw, /top-secret/);
});
