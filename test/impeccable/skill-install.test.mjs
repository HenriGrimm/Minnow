/**
 * Impeccable is installed into ~/.minnow/skills/impeccable, never read from the app bundle.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  ensureImpeccableSkillInstalled,
  MANAGED_SKILL_MARKER,
  resetImpeccableInstallCache,
  rewriteSkillPaths,
} from '../../server/impeccable/skill-install.js';
import { readImpeccableReference } from '../../server/impeccable/reference-handler.js';
import { readImpeccableUpstreamBody } from '../../server/impeccable/upstream-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const REPO_SEED = path.join(PROJECT_ROOT, 'src', 'skills', 'impeccable');

/** @param {string} dir @param {Record<string, string>} files */
function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

const SEED_SKILL_MD = '---\nname: impeccable\ndescription: test\n---\n\nFiles at `{{skill_dir}}`.\n';

describe('ensureImpeccableSkillInstalled', () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let seedDir;
  /** @type {string} */
  let installDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-impeccable-install-'));
    seedDir = path.join(tmp, 'seed');
    installDir = path.join(tmp, 'home', 'skills', 'impeccable');
    writeTree(seedDir, {
      'SKILL.md': SEED_SKILL_MD,
      'SKILL.upstream.md': 'Run `node src/skills/impeccable/scripts/palette.mjs`.\n',
      'harness-commands.json': '["init"]\n',
      'reference/init.md': 'node .agents/skills/impeccable/scripts/hook-admin.mjs\n',
      'scripts/palette.mjs': "console.log('src/skills/impeccable/scripts');\n",
      'harness-registry.mjs': 'export {};\n',
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('copies the payload and rewrites markdown paths to the install dir', () => {
    const dir = ensureImpeccableSkillInstalled(PROJECT_ROOT, { seedDir, installDir });
    assert.equal(dir, installDir);
    const posixDir = installDir.replace(/\\/g, '/');

    const skillMd = fs.readFileSync(path.join(installDir, 'SKILL.md'), 'utf8');
    assert.match(skillMd, new RegExp(`Files at \`${posixDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));

    const upstream = fs.readFileSync(path.join(installDir, 'SKILL.upstream.md'), 'utf8');
    assert.equal(upstream, `Run \`node ${posixDir}/scripts/palette.mjs\`.\n`);
    assert.equal(
      fs.readFileSync(path.join(installDir, 'reference', 'init.md'), 'utf8'),
      `node ${posixDir}/scripts/hook-admin.mjs\n`,
    );
    // Scripts are copied verbatim; Minnow server code is not part of the payload.
    assert.equal(
      fs.readFileSync(path.join(installDir, 'scripts', 'palette.mjs'), 'utf8'),
      "console.log('src/skills/impeccable/scripts');\n",
    );
    assert.equal(fs.existsSync(path.join(installDir, 'harness-registry.mjs')), false);
    assert.equal(fs.existsSync(path.join(installDir, MANAGED_SKILL_MARKER)), true);
  });

  it('refreshes reference/ and scripts/ when the seed changes, dropping stale files', () => {
    ensureImpeccableSkillInstalled(PROJECT_ROOT, { seedDir, installDir });
    fs.rmSync(path.join(seedDir, 'scripts', 'palette.mjs'));
    writeTree(seedDir, { 'scripts/live.mjs': 'export {};\n' });

    resetImpeccableInstallCache();
    ensureImpeccableSkillInstalled(PROJECT_ROOT, { seedDir, installDir });
    assert.equal(fs.existsSync(path.join(installDir, 'scripts', 'palette.mjs')), false);
    assert.equal(fs.existsSync(path.join(installDir, 'scripts', 'live.mjs')), true);
  });

  it('keeps a user-edited SKILL.md across refreshes but replaces an unedited one', () => {
    ensureImpeccableSkillInstalled(PROJECT_ROOT, { seedDir, installDir });
    const skillMdPath = path.join(installDir, 'SKILL.md');

    writeTree(seedDir, { 'SKILL.md': `${SEED_SKILL_MD}\nv2\n` });
    resetImpeccableInstallCache();
    ensureImpeccableSkillInstalled(PROJECT_ROOT, { seedDir, installDir });
    assert.match(fs.readFileSync(skillMdPath, 'utf8'), /v2/);

    fs.writeFileSync(skillMdPath, `${SEED_SKILL_MD}\nmy edits\n`, 'utf8');
    writeTree(seedDir, { 'SKILL.md': `${SEED_SKILL_MD}\nv3\n`, 'reference/init.md': 'v3\n' });
    resetImpeccableInstallCache();
    ensureImpeccableSkillInstalled(PROJECT_ROOT, { seedDir, installDir });
    assert.match(fs.readFileSync(skillMdPath, 'utf8'), /my edits/);
    assert.equal(fs.readFileSync(path.join(installDir, 'reference', 'init.md'), 'utf8'), 'v3\n');
  });

  it('reinstalls when the installed copy is deleted mid-process', () => {
    ensureImpeccableSkillInstalled(PROJECT_ROOT, { seedDir, installDir });
    fs.rmSync(installDir, { recursive: true, force: true });
    ensureImpeccableSkillInstalled(PROJECT_ROOT, { seedDir, installDir });
    assert.equal(fs.existsSync(path.join(installDir, 'SKILL.md')), true);
  });
});

describe('installed Impeccable content', () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let installDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-impeccable-real-'));
    installDir = path.join(tmp, 'impeccable');
    ensureImpeccableSkillInstalled(PROJECT_ROOT, { seedDir: REPO_SEED, installDir });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('no markdown file points agents at repo-relative or app-bundle skill paths', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.name.endsWith('.md')) {
          const text = fs.readFileSync(abs, 'utf8');
          if (/src\/skills\/impeccable\/|\.agents\/skills\/impeccable\/|app\.asar\//.test(text)) {
            offenders.push(path.relative(installDir, abs));
          }
          if (text.includes('{{skill_dir}}')) offenders.push(`${path.relative(installDir, abs)} (token)`);
        }
      }
    };
    walk(installDir);
    assert.deepEqual(offenders, []);
  });

  it('reference and upstream readers serve the installed copy', () => {
    const posixDir = installDir.replace(/\\/g, '/');
    const ref = readImpeccableReference(installDir, 'live');
    assert.ok(ref);
    assert.match(ref.content, new RegExp(`node ${posixDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/scripts/live\\.mjs`));

    const upstream = readImpeccableUpstreamBody(installDir);
    assert.ok(upstream);
    assert.ok(upstream.content.startsWith(`Impeccable skill files are installed at \`${posixDir}\``));
  });

  it('rewriteSkillPaths normalizes Windows separators', () => {
    assert.equal(
      rewriteSkillPaths('node src/skills/impeccable/scripts/x.mjs', 'C:\\Users\\me\\.minnow\\skills\\impeccable'),
      'node C:/Users/me/.minnow/skills/impeccable/scripts/x.mjs',
    );
  });
});
