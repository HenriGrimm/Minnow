import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { scanAgentPacks, loadAgentPacksState, isPackEnabled } from '../../server/agent-packs/scan.js';
import { validatePackManifest } from '../../server/agent-packs/validate.js';
import { ensureAgentPacksLayout, setPackEnabled } from '../../server/agent-packs/registry.js';

const fixtureRoot = join(
  process.cwd(),
  'test/fixtures/agent-packs/minimal-pack',
);
const builtinIds = new Set(['default', 'builder', 'planner']);

let tempHome = '';

before(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'minnow-agent-packs-'));
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

describe('agent-packs scan', () => {
  test('valid minimal pack is listed', async () => {
    const packs = await scanAgentPacks(process.cwd(), builtinIds);
    const minimal = packs.find((p) => p.id === 'minimal');
    assert.ok(minimal);
    assert.equal(minimal.valid, true);
    assert.equal(minimal.agents.length, 1);
    assert.equal(minimal.agents[0].id, 'minimal.helper');
  });

  test('missing manifest is skipped from valid list', async () => {
    const packsRoot = join(tempHome, 'agent-packs');
    await mkdir(join(packsRoot, 'empty-dir'), { recursive: true });
    const packs = await scanAgentPacks(process.cwd(), builtinIds);
    assert.ok(!packs.some((p) => p.id === 'empty-dir'));
  });

  test('invalid tool name fails validation', async () => {
    const badRoot = join(tempHome, 'agent-packs', 'bad-tools');
    await mkdir(join(badRoot, 'prompts'), { recursive: true });
    await writeFile(join(badRoot, 'prompts/a.full.md'), 'body\n', 'utf8');
    const badManifest = {
      id: 'bad-tools',
      label: 'Bad',
      version: '1.0.0',
      agents: [
        {
          key: 'a',
          label: 'A',
          prompts: { full: 'prompts/a.full.md' },
          allowedTools: ['not_a_real_tool'],
        },
      ],
    };
    await writeFile(
      join(badRoot, 'manifest.json'),
      `${JSON.stringify(badManifest, null, 2)}\n`,
      'utf8',
    );
    const result = validatePackManifest(badManifest, badRoot, builtinIds);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('Unknown tool')));
  });

  test('path traversal in prompt path is rejected', async () => {
    const badRoot = join(tempHome, 'agent-packs', 'traversal');
    const manifest = {
      id: 'traversal',
      label: 'Traversal',
      version: '1.0.0',
      agents: [
        {
          key: 'x',
          label: 'X',
          prompts: { full: '../../../etc/passwd' },
        },
      ],
    };
    await mkdir(badRoot, { recursive: true });
    await writeFile(
      join(badRoot, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    const result = validatePackManifest(manifest, badRoot, builtinIds);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  test('PATCH enable state persists in agent-packs.json', async () => {
    await setPackEnabled('minimal', false);
    const state = await loadAgentPacksState();
    assert.equal(state.minimal?.enabled, false);
    assert.equal(isPackEnabled(state, 'minimal', true), false);
    await setPackEnabled('minimal', true);
  });
});

describe('ensureAgentPacksLayout', () => {
  /** @type {string[]} */
  const tempHomes = [];

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await Promise.all(
      tempHomes.map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  async function useFreshHome() {
    const home = await mkdtemp(join(tmpdir(), 'minnow-agent-packs-fresh-'));
    tempHomes.push(home);
    process.env.MINNOW_HOME = home;
    resetMinnowHomeCache();
    return home;
  }

  test('scaffolds template pack on fresh ~/.minnow home', async () => {
    const freshHome = await useFreshHome();
    await ensureAgentPacksLayout();

    const templateDir = join(freshHome, 'agent-packs', '_template');
    await access(join(templateDir, 'manifest.json'));
    await access(join(templateDir, 'prompts', 'example.full.md'));
    await access(join(templateDir, 'README.md'));
  });

  test('repairs partial template scaffold missing prompt files', async () => {
    const freshHome = await useFreshHome();
    const templateDir = join(freshHome, 'agent-packs', '_template');
    await mkdir(templateDir, { recursive: true });
    await writeFile(join(templateDir, 'manifest.json'), '{}\n', 'utf8');

    await ensureAgentPacksLayout();

    await access(join(templateDir, 'prompts', 'example.full.md'));
  });
});
