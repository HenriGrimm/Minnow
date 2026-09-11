/**
 * Scan skill directories under built-in and user roots.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import fsSync from 'node:fs';
import { getMinnowHome } from '../config/home.js';
import {
  ensureImpeccableSkillInstalled,
  IMPECCABLE_SKILL_ID,
  MANAGED_SKILL_MARKER,
} from '../impeccable/skill-install.js';
import { defaultSkillLabel, parseSkillFrontmatter } from './parse-frontmatter.js';

/** Skill id: lowercase alphanumeric with hyphens. */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * @param {string} projectRoot
 * @returns {string}
 */
export function getBuiltinSkillsRoot(projectRoot) {
  return path.join(projectRoot, 'src', 'skills');
}

/**
 * @returns {string}
 */
export function getUserSkillsRoot() {
  return path.join(getMinnowHome(), 'skills');
}

/**
 * @param {string} dirName
 * @returns {boolean}
 */
/** Non-skill infrastructure folders under src/skills (not user skill installs). */
const NON_SKILL_DIRS = new Set(['library']);

/**
 * Built-ins installed into ~/.minnow/skills and only ever served from there, so
 * agents never see paths inside the app bundle (app.asar when packaged).
 */
const HOME_INSTALLED_BUILTINS = new Set([IMPECCABLE_SKILL_ID]);

export function shouldExposeSkillDir(dirName) {
  if (dirName.startsWith('_')) return false;
  if (NON_SKILL_DIRS.has(dirName)) return false;
  return true;
}

/**
 * User-root skills Minnow installed itself still report as built-in.
 * @param {string} skillDir
 * @returns {'builtin' | 'user'}
 */
function userRootSkillSource(skillDir) {
  return fsSync.existsSync(path.join(skillDir, MANAGED_SKILL_MARKER)) ? 'builtin' : 'user';
}

/**
 * @param {string} projectRoot Minnow install root
 */
function ensureHomeInstalledBuiltins(projectRoot) {
  ensureImpeccableSkillInstalled(projectRoot);
}

/**
 * @param {string} rootDir
 * @param {'builtin' | 'user'} source
 * @returns {Promise<import('./types.js').SkillListItem[]>}
 */
export async function scanSkillDir(rootDir, source) {
  /** @type {import('./types.js').SkillListItem[]} */
  const items = [];

  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return items;
    }
    console.warn(`[skills] Cannot read ${rootDir}:`, err);
    return items;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!shouldExposeSkillDir(entry.name)) continue;
    if (source === 'builtin' && HOME_INSTALLED_BUILTINS.has(entry.name)) continue;

    const skillPath = path.join(rootDir, entry.name, 'SKILL.md');
    let raw;
    try {
      raw = await fs.readFile(skillPath, 'utf8');
    } catch {
      console.warn(`[skills] Skip ${entry.name}: missing or unreadable SKILL.md`);
      continue;
    }

    try {
      const { meta } = parseSkillFrontmatter(raw);
      const id = meta.name.trim();
      if (id !== entry.name) {
        console.warn(
          `[skills] Skip ${entry.name}: front matter name "${id}" does not match folder`,
        );
        continue;
      }
      if (!SKILL_ID_RE.test(id)) {
        console.warn(`[skills] Skip ${id}: invalid id format`);
        continue;
      }

      items.push({
        id,
        label: meta.label?.trim() || defaultSkillLabel(id),
        description: meta.description.trim(),
        source: source === 'user' ? userRootSkillSource(path.join(rootDir, entry.name)) : source,
        path: skillPath,
        version: meta.version?.trim() || undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[skills] Skip ${entry.name}: ${message}`);
    }
  }

  return items;
}

/**
 * Merge built-in and user lists; user wins on duplicate id; sort by label.
 * @param {import('./types.js').SkillListItem[]} builtin
 * @param {import('./types.js').SkillListItem[]} user
 */
export function mergeSkillLists(builtin, user) {
  const byId = new Map();
  for (const item of builtin) {
    byId.set(item.id, item);
  }
  for (const item of user) {
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
}

/**
 * @param {string} projectRoot
 * @returns {Promise<import('./types.js').SkillListItem[]>}
 */
export async function listMergedSkills(projectRoot) {
  const builtinRoot = getBuiltinSkillsRoot(projectRoot);
  const userRoot = getUserSkillsRoot();

  try {
    await fs.mkdir(userRoot, { recursive: true });
  } catch {
    /* ignore */
  }
  ensureHomeInstalledBuiltins(projectRoot);

  const [builtin, user] = await Promise.all([
    scanSkillDir(builtinRoot, 'builtin'),
    scanSkillDir(userRoot, 'user'),
  ]);

  return mergeSkillLists(builtin, user);
}

/**
 * @param {string} projectRoot
 * @param {string} id
 * @returns {Promise<import('./types.js').SkillDetail | null>}
 */
export async function getSkillById(projectRoot, id) {
  if (!SKILL_ID_RE.test(id)) return null;

  const homeInstalled = HOME_INSTALLED_BUILTINS.has(id);
  if (homeInstalled) ensureHomeInstalledBuiltins(projectRoot);

  const userRoot = getUserSkillsRoot();
  const builtinRoot = getBuiltinSkillsRoot(projectRoot);
  const userPath = path.join(userRoot, id, 'SKILL.md');
  const builtinPath = path.join(builtinRoot, id, 'SKILL.md');

  let raw = null;
  let source = /** @type {'builtin' | 'user'} */ ('builtin');
  let skillPath = builtinPath;

  try {
    raw = await fs.readFile(userPath, 'utf8');
    source = userRootSkillSource(path.dirname(userPath));
    skillPath = userPath;
  } catch {
    if (homeInstalled) return null;
    try {
      raw = await fs.readFile(builtinPath, 'utf8');
      source = 'builtin';
      skillPath = builtinPath;
    } catch {
      return null;
    }
  }

  try {
    const { meta, body } = parseSkillFrontmatter(raw);
    if (meta.name.trim() !== id) return null;

    return {
      id,
      label: meta.label?.trim() || defaultSkillLabel(id),
      description: meta.description.trim(),
      source,
      path: skillPath,
      version: meta.version?.trim() || undefined,
      body,
      raw,
      disableModelInvocation: meta['disable-model-invocation'] === 'true',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[skills] Invalid ${id}: ${message}`);
    return null;
  }
}
