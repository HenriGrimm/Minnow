import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { loadWorkAgentRegistry, readWorkAgentPrompt } from '../../server/work-agents/registry.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '../..');
const fixtureRoot = join(projectRoot, 'test/fixtures/agent-packs/minimal-pack');

let tempHome = '';

before(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'minnow-wa-pack-'));
  process.env.MINNOW_HOME = tempHome;
  resetMinnowHomeCache();

  const packsRoot = join(tempHome, 'agent-packs');
  await mkdir(packsRoot, { recursive: true });
  await cp(fixtureRoot, join(packsRoot, 'minimal'), { recursive: true });
});

after(async () => {
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
});

describe('work agent registry with packs', () => {
  test('loadWorkAgentRegistry includes pack agent', async () => {
    const { agents } = await loadWorkAgentRegistry(projectRoot);
    const packAgent = agents.find((a) => a.id === 'minimal.helper');
    assert.ok(packAgent);
    assert.equal(packAgent.source, 'pack');
    assert.equal(packAgent.packId, 'minimal');
  });

  test('readWorkAgentPrompt resolves pack prompt file', async () => {
    const result = await readWorkAgentPrompt(projectRoot, 'minimal.helper');
    assert.equal(result.source, 'pack');
    assert.match(result.content, /minimal pack helper/i);
  });
});
