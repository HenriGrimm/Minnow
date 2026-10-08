import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { toolLoadAestheticsReference } from '../../server/design/load-aesthetics-reference.js';
import { toolLoadSkill } from '../../server/skills/load-skill.js';
import { scanSkillDir } from '../../server/skills/scan.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const previousHome = process.env.MINNOW_HOME;
let scratch;
let appRoot;

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-frontend-skill-'));
  appRoot = path.join(scratch, 'app');
  process.env.MINNOW_HOME = path.join(scratch, 'home');
  resetMinnowHomeCache();
  await fs.cp(
    path.join(repoRoot, 'src/skills/frontend-design'),
    path.join(appRoot, 'src/skills/frontend-design'),
    { recursive: true },
  );
});

after(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  await fs.rm(scratch, { recursive: true, force: true });
});

test('frontend-design ships in the offline manifest and agent catalog', async () => {
  const { skills } = JSON.parse(await fs.readFile(path.join(repoRoot, 'src/skills/builtin-manifest.json'), 'utf8'));
  const manifestSkill = skills.find(skill => skill.id === 'frontend-design');
  const scannedSkill = (await scanSkillDir(path.join(appRoot, 'src/skills'), 'builtin'))[0];
  assert.equal(scannedSkill.id, 'frontend-design');
  assert.equal(scannedSkill.label, 'Frontend Design');
  assert.equal(scannedSkill.disableModelInvocation, false);
  const { path: skillPath, ...metadata } = scannedSkill;
  assert.equal(skillPath, path.join(appRoot, 'src/skills/frontend-design/SKILL.md'));
  assert.deepEqual(manifestSkill, JSON.parse(JSON.stringify(metadata)));

  const catalog = JSON.parse((await toolLoadSkill({ query: 'frontend' }, appRoot)).result);
  assert.equal(catalog.total, 1);
  assert.equal(catalog.skills[0].id, 'frontend-design');
  assert.equal(catalog.skills[0].source, 'builtin');
  const loaded = JSON.parse((await toolLoadSkill({ id: 'frontend-design' }, appRoot)).result);
  assert.equal(loaded.id, 'frontend-design');
  assert.ok(loaded.content.length > 0);
  assert.equal(loaded.next_offset, null);
});

test('bundled guidance can be read completely through load_skill and the existing reference tool', async () => {
  const reference = 'reference/frontend-aesthetics.md';
  const lines = [];
  let offset = 1;
  do {
    const page = JSON.parse((await toolLoadSkill({ id: 'frontend-design', reference, offset }, appRoot)).result);
    assert.equal(page.reference, reference);
    lines.push(page.content);
    offset = page.next_offset;
  } while (offset !== null);
  const expected = await fs.readFile(path.join(appRoot, 'src/skills/frontend-design', reference), 'utf8');
  assert.equal(lines.join('\n'), expected.replaceAll('\r\n', '\n'));
  assert.equal((await toolLoadAestheticsReference(appRoot)).result, expected);
});
