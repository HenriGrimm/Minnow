/**
 * Installed Skills Library provenance (~/.minnow/skills/installed-skills.json).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getUserSkillsRoot } from '../scan.js';

let mutationChain = Promise.resolve();

function mutateProvenance(mutator) {
  const result = mutationChain.then(async () => {
    const data = await readProvenance();
    const value = mutator(data);
    if (value !== false) await writeProvenance(data);
    return value;
  });
  mutationChain = result.then(() => {}, () => {});
  return result;
}

/**
 * @typedef {Object} InstalledSkillProvenance
 * @property {string} [pack] Curated pack id when installed from the library.
 * @property {string} repo GitHub owner/repo slug.
 * @property {string} commit Full 40-char commit SHA.
 * @property {string} subpath Repo-relative skill folder path.
 * @property {string} installedAt ISO timestamp.
 * @property {string} sha256 Content hash for the installed skill tree.
 */

/**
 * @returns {string}
 */
export function getProvenancePath() {
  return path.join(getUserSkillsRoot(), 'installed-skills.json');
}

/**
 * @returns {Promise<Record<string, InstalledSkillProvenance>>}
 */
export async function readProvenance() {
  const filePath = getProvenancePath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return /** @type {Record<string, InstalledSkillProvenance>} */ (parsed);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

/**
 * @param {Record<string, InstalledSkillProvenance>} data
 */
export async function writeProvenance(data) {
  const userRoot = getUserSkillsRoot();
  await fs.mkdir(userRoot, { recursive: true });
  const filePath = getProvenancePath();
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * @param {string} skillId
 * @param {InstalledSkillProvenance} entry
 */
export async function recordProvenance(skillId, entry) {
  await mutateProvenance((data) => { data[skillId] = entry; });
}

/**
 * @param {string} skillId
 */
export async function removeProvenanceEntry(skillId) {
  return mutateProvenance((data) => {
    if (!data[skillId]) return false;
    delete data[skillId];
    return true;
  });
}

/**
 * Count installed skills per curated pack id.
 * @returns {Promise<Record<string, number>>}
 */
export async function countInstalledByPack() {
  const data = await readProvenance();
  /** @type {Record<string, number>} */
  const counts = {};
  for (const entry of Object.values(data)) {
    if (!entry.pack) continue;
    counts[entry.pack] = (counts[entry.pack] ?? 0) + 1;
  }
  return counts;
}
