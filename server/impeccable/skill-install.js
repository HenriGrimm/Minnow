/**
 * Install the Impeccable skill into ~/.minnow/skills/impeccable.
 *
 * Minnow ships a Minnow-patched copy of Impeccable (src/skills/impeccable in the
 * repo; Resources/skills/impeccable in packaged builds — outside app.asar). Agents
 * never read that copy: it is installed into the user skills root, and every
 * `src/skills/impeccable/…` path in the markdown is rewritten to the installed
 * location so `node …/scripts/x.mjs` and `reference/*.md` reads work from any
 * workspace (a packaged app.asar is unreadable by shell tools and real node).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';

export const IMPECCABLE_SKILL_ID = 'impeccable';

/** Marker written last by the installer; also tells the skill scanner the dir is Minnow-managed. */
export const MANAGED_SKILL_MARKER = '.minnow-managed.json';

/** Skill payload copied from the seed. Minnow server code (harness-registry*.mjs) stays in the app. */
const PAYLOAD_FILES = ['SKILL.md', 'SKILL.upstream.md', 'harness-commands.json'];
const PAYLOAD_DIRS = ['reference', 'scripts'];

/** Repo-relative prefixes the vendored markdown uses for skill files. */
const REWRITTEN_PREFIXES = ['src/skills/impeccable/', '.agents/skills/impeccable/'];
const SKILL_DIR_TOKEN = '{{skill_dir}}';

/**
 * @returns {string}
 */
export function getInstalledImpeccableDir() {
  return path.join(getMinnowHome(), 'skills', IMPECCABLE_SKILL_ID);
}

/**
 * Where the shipped copy lives: Resources/skills/impeccable when packaged,
 * otherwise the repo checkout.
 * @param {string} appRoot
 * @returns {string}
 */
export function resolveImpeccableSeedDir(appRoot) {
  const resourcesPath =
    typeof process.resourcesPath === 'string' ? process.resourcesPath.trim() : '';
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'skills', IMPECCABLE_SKILL_ID);
    if (fs.existsSync(path.join(packaged, 'SKILL.md'))) return packaged;
  }
  return path.join(appRoot, 'src', 'skills', IMPECCABLE_SKILL_ID);
}

/**
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]} posix relative paths, sorted
 */
function listFilesRecursive(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * @param {string} seedDir
 * @returns {string[]}
 */
function listPayload(seedDir) {
  const files = PAYLOAD_FILES.filter((name) => fs.existsSync(path.join(seedDir, name)));
  for (const sub of PAYLOAD_DIRS) {
    const abs = path.join(seedDir, sub);
    if (fs.existsSync(abs)) files.push(...listFilesRecursive(abs, sub));
  }
  return files.sort();
}

/**
 * @param {string | Buffer} content
 */
function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * @param {string} seedDir
 * @param {string[]} files
 */
function hashPayload(seedDir, files) {
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(seedDir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Point repo-relative skill paths at the installed directory.
 * @param {string} text
 * @param {string} installDir
 * @returns {string}
 */
export function rewriteSkillPaths(text, installDir) {
  const dir = installDir.replace(/\\/g, '/');
  let out = text.replaceAll(SKILL_DIR_TOKEN, dir);
  for (const prefix of REWRITTEN_PREFIXES) {
    out = out.replaceAll(prefix, `${dir}/`);
  }
  return out;
}

/**
 * @param {string} file
 * @returns {Record<string, unknown> | null}
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Copy the seed into installDir, rewriting markdown paths. A SKILL.md the user
 * edited (or a pre-existing override with no marker) is kept.
 * @param {string} seedDir
 * @param {string} installDir
 * @param {string[]} files
 * @param {string} seedHash
 */
function installPayload(seedDir, installDir, files, seedHash) {
  const markerPath = path.join(installDir, MANAGED_SKILL_MARKER);
  const skillMdPath = path.join(installDir, 'SKILL.md');
  const previous = readJson(markerPath);
  let keepSkillMd = false;
  if (fs.existsSync(skillMdPath)) {
    keepSkillMd =
      !previous || sha256(fs.readFileSync(skillMdPath)) !== previous.skillMdHash;
  }

  fs.mkdirSync(installDir, { recursive: true });
  // Invalidate the seed hash first so a crash mid-copy forces a reinstall next
  // time, while keeping skillMdHash so our own SKILL.md is not mistaken for an edit.
  if (previous) {
    fs.writeFileSync(markerPath, JSON.stringify({ ...previous, seedHash: null }), 'utf8');
  }
  for (const sub of PAYLOAD_DIRS) {
    fs.rmSync(path.join(installDir, sub), { recursive: true, force: true });
  }

  for (const rel of files) {
    if (rel === 'SKILL.md' && keepSkillMd) continue;
    const src = path.join(seedDir, rel);
    const dest = path.join(installDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (rel.endsWith('.md')) {
      fs.writeFileSync(dest, rewriteSkillPaths(fs.readFileSync(src, 'utf8'), installDir), 'utf8');
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  const marker = {
    skill: IMPECCABLE_SKILL_ID,
    seedHash,
    skillMdHash: keepSkillMd
      ? (previous?.skillMdHash ?? null)
      : sha256(fs.readFileSync(skillMdPath)),
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

/** @type {Map<string, string>} installDir → seedHash installed by this process */
const installedThisProcess = new Map();

/** Forget per-process install state so the next call re-hashes the seed (tests). */
export function resetImpeccableInstallCache() {
  installedThisProcess.clear();
}

/**
 * Ensure ~/.minnow/skills/impeccable matches the shipped seed; returns the installed dir.
 * Cheap after the first call per process (one existsSync).
 * @param {string} appRoot Minnow install root
 * @param {{ seedDir?: string, installDir?: string }} [opts]
 * @returns {string}
 */
export function ensureImpeccableSkillInstalled(appRoot, opts = {}) {
  const installDir = opts.installDir ?? getInstalledImpeccableDir();
  const markerPath = path.join(installDir, MANAGED_SKILL_MARKER);
  if (installedThisProcess.has(installDir) && fs.existsSync(path.join(installDir, 'SKILL.md'))) {
    return installDir;
  }

  const seedDir = opts.seedDir ?? resolveImpeccableSeedDir(appRoot);
  if (!fs.existsSync(path.join(seedDir, 'SKILL.md'))) {
    console.warn(`[impeccable] No bundled skill at ${seedDir}; using ${installDir} as-is`);
    return installDir;
  }

  try {
    const files = listPayload(seedDir);
    const seedHash = hashPayload(seedDir, files);
    const marker = readJson(markerPath);
    if (marker?.seedHash !== seedHash) {
      installPayload(seedDir, installDir, files, seedHash);
      console.log(`[impeccable] Installed skill → ${installDir}`);
    }
    installedThisProcess.set(installDir, seedHash);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[impeccable] Could not install skill into ${installDir}: ${message}`);
  }
  return installDir;
}
