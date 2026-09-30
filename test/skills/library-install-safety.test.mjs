import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { readConfigJson } from '../../server/config/store.js';
import { installSkillTree, removeInstalledSkill } from '../../server/skills/library/install.js';
import { readProvenance } from '../../server/skills/library/provenance.js';

let homeDir;
const previousHome = process.env.MINNOW_HOME;

before(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-skill-stage-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
});

after(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  await fs.rm(homeDir, { recursive: true, force: true });
});

function options(skillId, body = 'initial') {
  return {
    skillId, repo: 'example/skills', commit: 'a'.repeat(40), subpath: skillId,
    files: [{ relPath: 'SKILL.md', content: `---\nname: ${skillId}\ndescription: Test skill\n---\n\n${body}\n` }],
  };
}

test('invalid staged files leave the previous skill and provenance untouched', async () => {
  const original = await installSkillTree(options('staged-skill'));
  const file = path.join(original.path, 'SKILL.md');
  const before = await fs.readFile(file, 'utf8');
  const provenance = (await readProvenance())['staged-skill'];
  await assert.rejects(() => installSkillTree({
    ...options('staged-skill', 'new version'),
    files: [...options('staged-skill', 'new version').files, { relPath: '../escape', content: 'bad' }],
  }), /Unsafe skill file path/);
  await assert.rejects(() => installSkillTree({
    ...options('staged-skill', 'new version'),
    postInstallPatch: 'matt-pocock',
    files: options('wrong-name').files,
  }), /Staged SKILL.md name/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual((await readProvenance())['staged-skill'], provenance);
});

test('local modifications and untracked name collisions are preserved', async () => {
  const original = await installSkillTree(options('edited-skill'));
  const file = path.join(original.path, 'SKILL.md');
  await fs.appendFile(file, '\nlocal note\n');
  await assert.rejects(() => installSkillTree(options('edited-skill', 'new version')), /local changes/);
  await assert.rejects(() => removeInstalledSkill('edited-skill'), /local changes/);
  assert.match(await fs.readFile(file, 'utf8'), /local note/);

  const collision = path.join(homeDir, 'skills', 'personal-skill');
  await fs.mkdir(collision);
  await fs.writeFile(path.join(collision, 'SKILL.md'), 'personal copy');
  await assert.rejects(() => installSkillTree(options('personal-skill')), /already exists outside the library/);
  assert.equal(await fs.readFile(path.join(collision, 'SKILL.md'), 'utf8'), 'personal copy');
});

test('concurrent installs retain every provenance and enabled-config entry', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `concurrent-${index}`);
  await Promise.all(ids.map((id) => installSkillTree(options(id))));
  const provenance = await readProvenance();
  const config = await readConfigJson('skills.json');
  for (const id of ids) {
    assert.equal(provenance[id]?.repo, 'example/skills');
    assert.equal(config.enabled[id], true);
  }
});

test('metadata failure rolls the installed tree and provenance back to the previous version', async () => {
  const original = await installSkillTree(options('rollback-skill'));
  const originalFiles = await fs.readFile(path.join(original.path, 'SKILL.md'), 'utf8');
  const originalProvenance = (await readProvenance())['rollback-skill'];
  const configPath = path.join(homeDir, 'skills.json');
  const savedConfig = await fs.readFile(configPath);
  await fs.unlink(configPath);
  await fs.mkdir(configPath);
  try {
    await assert.rejects(() => installSkillTree(options('rollback-skill', 'replacement')));
    assert.equal(await fs.readFile(path.join(original.path, 'SKILL.md'), 'utf8'), originalFiles);
    assert.deepEqual((await readProvenance())['rollback-skill'], originalProvenance);
  } finally {
    await fs.rmdir(configPath);
    await fs.writeFile(configPath, savedConfig);
  }
});
