/**
 * Step 14 — Impeccable built-in skill (deterministic, static assertions).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { getSkillById, listMergedSkills } from '../server/skills/scan.js';
import { readImpeccableReference } from '../server/impeccable/reference-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SKILL_DIR = path.join(PROJECT_ROOT, 'src/skills/impeccable');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');

// listMergedSkills installs Impeccable into the Minnow home — never the real ~/.minnow.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-skills-impeccable-'));
process.env.MINNOW_HOME = TEST_HOME;
const INSTALLED_DIR = path.join(TEST_HOME, 'skills', 'impeccable');
const FORBIDDEN_OKLCH = 'oklch(88.769% 0.2563 138.508';

describe('Impeccable built-in (Step 14)', () => {
  after(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('skill directory and SKILL.md exist', () => {
    assert.equal(fs.existsSync(SKILL_MD), true);
    assert.equal(fs.statSync(SKILL_MD).isFile(), true);
  });

  it('front matter name is impeccable', () => {
    const raw = fs.readFileSync(SKILL_MD, 'utf8');
    assert.match(raw, /^name:\s*impeccable\s*$/m);
  });

  it('context files exist at repo root', () => {
    assert.equal(fs.existsSync(path.join(PROJECT_ROOT, 'PRODUCT.md')), true);
    assert.equal(fs.existsSync(path.join(PROJECT_ROOT, 'DESIGN.md')), true);
    assert.equal(
      fs.existsSync(path.join(PROJECT_ROOT, '.impeccable', 'design.json')),
      true,
    );
  });

  it('design.json schemaVersion is 2 or 3', () => {
    const design = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, '.impeccable', 'design.json'), 'utf8'),
    );
    assert.ok(design.schemaVersion === 2 || design.schemaVersion === 3);
  });

  it('SKILL.md references context files without duplicating OKLCH tokens', () => {
    const body = fs.readFileSync(SKILL_MD, 'utf8');
    assert.match(body, /PRODUCT\.md/);
    assert.match(body, /DESIGN\.md/);
    assert.match(body, /\.impeccable\/design\.json/);
    assert.equal(body.includes(FORBIDDEN_OKLCH), false);
  });

  it('synced reference and scripts directories exist', () => {
    assert.equal(
      fs.existsSync(path.join(PROJECT_ROOT, 'src/skills/impeccable/reference/init.md')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(PROJECT_ROOT, 'src/skills/impeccable/reference/audit.md')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(PROJECT_ROOT, 'src/skills/impeccable/scripts/load-context.mjs')),
      true,
    );
  });

  it('loader lists impeccable in merged skills from the ~/.minnow install', async () => {
    const skills = await listMergedSkills(PROJECT_ROOT);
    const impeccable = skills.find((s) => s.id === 'impeccable');
    assert.ok(impeccable);
    assert.equal(impeccable.source, 'builtin');
    assert.equal(impeccable.path, path.join(INSTALLED_DIR, 'SKILL.md'));
    assert.match(impeccable.description, /DESIGN\.md|design/i);
  });

  it('loadSkill body includes context pointers and installed paths', async () => {
    const skill = await getSkillById(PROJECT_ROOT, 'impeccable');
    assert.ok(skill);
    assert.equal(skill.id, 'impeccable');
    assert.equal(skill.source, 'builtin');
    assert.equal(skill.path, path.join(INSTALLED_DIR, 'SKILL.md'));
    assert.ok(skill.body.length > 500);
    assert.match(skill.body, /PRODUCT\.md|load-context|minnow-context/);
    assert.equal(skill.body.includes('src/skills/impeccable/'), false);
    assert.ok(skill.body.includes(`${INSTALLED_DIR.replace(/\\/g, '/')}/scripts/minnow-context.mjs`));
  });

  it('minnow-context.mjs exits 0 with designJson', () => {
    const result = spawnSync(
      process.execPath,
      ['src/skills/impeccable/scripts/minnow-context.mjs'],
      { cwd: PROJECT_ROOT, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(typeof payload.contextDir, 'string');
    assert.equal(payload.hasProduct, true);
    assert.equal(typeof payload.product, 'string');
    assert.equal(payload.hasDesign, true);
    assert.equal(typeof payload.design, 'string');
    assert.equal(payload.hasDesignJson, true);
    assert.equal(payload.designJson.schemaVersion, 3);
    assert.equal(payload.workspaceRoot, PROJECT_ROOT);
  });

  it('minnow-context.mjs soft success without .impeccable/design.json', () => {
    const partialFixture = path.join(
      PROJECT_ROOT,
      'test/fixtures/impeccable-workspace-partial',
    );
    const result = spawnSync(
      process.execPath,
      ['src/skills/impeccable/scripts/minnow-context.mjs'],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: { ...process.env, IMPECCABLE_CONTEXT_DIR: partialFixture },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hasProduct, true);
    assert.equal(payload.hasDesign, true);
    assert.equal(payload.hasDesignJson, false);
    assert.equal(payload.designJson, null);
    assert.match(payload.designJsonSetupHint, /\/impeccable document/);
  });

  it('minnow-context.mjs honors IMPECCABLE_CONTEXT_DIR', () => {
    const result = spawnSync(
      process.execPath,
      ['src/skills/impeccable/scripts/minnow-context.mjs'],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: { ...process.env, IMPECCABLE_CONTEXT_DIR: PROJECT_ROOT },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(path.resolve(payload.workspaceRoot), PROJECT_ROOT);
  });

  it('reference API resolves teach alias to init.md', () => {
    const payload = readImpeccableReference(SKILL_DIR, 'teach');
    assert.ok(payload);
    assert.equal(payload.command, 'init');
    assert.match(payload.content, /PRODUCT\.md/);
    assert.match(payload.content, /# Init Flow/i);
  });

  it('harness reference files have no unpatched {{template}} tokens', () => {
    const refDir = path.join(PROJECT_ROOT, 'src/skills/impeccable/reference');
    const harnessNames = [
      'init', 'craft', 'shape', 'document', 'extract', 'critique', 'audit',
      'polish', 'bolder', 'quieter', 'distill', 'harden', 'onboard', 'live',
      'animate', 'colorize', 'typeset', 'layout', 'delight', 'overdrive',
      'clarify', 'adapt', 'optimize',
    ];
    const tokenRe = /\{\{[^}]+\}\}/;
    for (const name of harnessNames) {
      const filePath = path.join(refDir, `${name}.md`);
      assert.equal(fs.existsSync(filePath), true, `${name}.md missing`);
      const withoutJsxStyle = fs
        .readFileSync(filePath, 'utf8')
        .replace(/style=\{\{[^}]*\}\}/g, '');
      assert.equal(
        tokenRe.test(withoutJsxStyle),
        false,
        `${name}.md still has {{template}} tokens`,
      );
    }
  });

  it('reference API rejects unknown command', () => {
    assert.equal(readImpeccableReference(SKILL_DIR, 'not-a-real-command'), null);
  });

  it('sync script is idempotent', () => {
    const run = () =>
      spawnSync(process.execPath, ['scripts/sync-impeccable-skill.mjs'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
      });
    const first = run();
    const second = run();
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);
  });
});
