/**
 * Skills Library install flow — fetch, write, provenance, enable (MIN-475).
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { updateConfigJson } from '../../config/store.js';
import { normalizeSkillConfig } from '../../config/validators.js';
import { parseSkillFrontmatter } from '../parse-frontmatter.js';
import { getUserSkillsRoot, SKILL_ID_RE } from '../scan.js';
import {
  fetchSkillDirectoryFiles,
  parseGitHubRepoUrl,
  resolveCommitSha,
} from './github-fetch.js';
import { readProvenance, recordProvenance, removeProvenanceEntry } from './provenance.js';
import { runPostInstallPatch } from './post-install.js';
import {
  SKILLS_LIBRARY_MAX_BYTES_PER_SKILL,
  SKILLS_LIBRARY_MAX_FILES_PER_SKILL,
} from './constants.js';

let installMutationChain = Promise.resolve();

function withInstallMutation(work) {
  const result = installMutationChain.then(work, work);
  installMutationChain = result.then(() => {}, () => {});
  return result;
}

/**
 * @param {Array<{ relPath: string, content: string }>} files
 * @returns {string}
 */
export function computeSkillSha256(files) {
  const hash = createHash('sha256');
  const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));
  for (const file of sorted) {
    hash.update(file.relPath);
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * @param {string} skillId
 */
export async function enableSkill(skillId) {
  await updateConfigJson('skills.json', (raw) => {
    const config = normalizeSkillConfig(raw ?? { enabled: {} });
    config.enabled[skillId] = true;
    return config;
  });
}

/** Stage a complete skill tree beside the final destination. */
/** @param {string} skillId */
/** @param {Array<{ relPath: string, content: string }>} files */
async function stageSkillFiles(skillId, files) {
  if (!SKILL_ID_RE.test(skillId) || skillId.startsWith('_')) {
    throw new Error(`Invalid skill id "${skillId}"`);
  }
  const paths = new Set();
  for (const file of files) {
    const rel = file.relPath.replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || rel.includes(':') ||
      rel.split('/').some((part) => !part || part === '.' || part === '..') || paths.has(rel)) {
      throw new Error(`Unsafe skill file path: ${file.relPath}`);
    }
    paths.add(rel);
  }
  if (!paths.has('SKILL.md')) throw new Error('SKILL.md is required');

  const root = getUserSkillsRoot();
  await fs.mkdir(root, { recursive: true });
  const skillDir = await fs.mkdtemp(path.join(root, '.stage-skill-'));
  try {
    for (const file of files) {
      const rel = file.relPath.replace(/\\/g, '/');
      const dest = path.join(skillDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.content, 'utf8');
    }
  } catch (err) {
    await fs.rm(skillDir, { recursive: true, force: true });
    throw err;
  }

  return skillDir;
}

/** Hash the files actually installed, including post-install patches and local additions. */
async function skillFilesOnDisk(skillDir) {
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full, relPath);
      else if (entry.isFile()) files.push({ relPath, content: await fs.readFile(full, 'utf8') });
      else throw new Error(`Skill contains unsupported file: ${relPath}`);
    }
  }
  await visit(skillDir);
  return files;
}

async function directoryExists(directory) {
  try {
    await fs.access(directory);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * @param {Array<{ relPath: string, content: string }>} files
 * @returns {string}
 */
export function resolveSkillIdFromFiles(files) {
  const skillMd = files.find((file) => file.relPath === 'SKILL.md' || file.relPath.endsWith('/SKILL.md'));
  if (!skillMd) {
    throw new Error('SKILL.md is required');
  }

  const { meta } = parseSkillFrontmatter(skillMd.content);
  const id = meta.name.trim();
  if (!SKILL_ID_RE.test(id) || id.startsWith('_')) {
    throw new Error(`Invalid skill id in SKILL.md front matter: "${id}"`);
  }
  return id;
}

/**
 * @param {{
 *   skillId: string,
 *   repo: string,
 *   commit: string,
 *   subpath: string,
 *   pack?: string,
 *   postInstallPatch?: string,
 *   files: Array<{ relPath: string, content: string }>,
 * }} options
 * @returns {Promise<{ skillId: string, path: string, sha256: string }>}
 */
export async function installSkillTree(options) {
  const { skillId, repo, commit, subpath, pack, postInstallPatch, files } = options;
  if (!/^[^/]+\/[^/]+$/.test(repo) || !/^[0-9a-f]{40}$/i.test(commit) ||
    typeof subpath !== 'string' || subpath.split('/').includes('..') ||
    (pack !== undefined && typeof pack !== 'string')) {
    throw new Error('Invalid skill provenance');
  }
  const resolvedId = resolveSkillIdFromFiles(files);
  if (!postInstallPatch && resolvedId !== skillId) {
    throw new Error(`Skill id mismatch: index says "${skillId}" but SKILL.md name is "${resolvedId}"`);
  }

  const stageDir = await stageSkillFiles(skillId, files);
  try {
    if (postInstallPatch) {
      await runPostInstallPatch(postInstallPatch, stageDir, { skillId, subpath });
    }
    const patchedSkillMd = await fs.readFile(path.join(stageDir, 'SKILL.md'), 'utf8');
    const { meta } = parseSkillFrontmatter(patchedSkillMd);
    const patchedId = meta.name.trim();
    if (patchedId !== skillId) {
      throw new Error(
        `Staged SKILL.md name "${patchedId}" does not match "${skillId}"`,
      );
    }
    const stagedFiles = await skillFilesOnDisk(stageDir);
    if (stagedFiles.length > SKILLS_LIBRARY_MAX_FILES_PER_SKILL ||
      stagedFiles.reduce((size, file) => size + Buffer.byteLength(file.content, 'utf8'), 0) > SKILLS_LIBRARY_MAX_BYTES_PER_SKILL) {
      throw new Error('Staged skill exceeds install limits');
    }
    const sha256 = computeSkillSha256(stagedFiles);
    return await withInstallMutation(async () => {
      const skillDir = path.join(getUserSkillsRoot(), skillId);
      const provenance = await readProvenance();
      const previous = provenance[skillId];
      const exists = await directoryExists(skillDir);
      let currentHash = '';
      if (exists) {
        if (!previous) throw new Error(`Skill "${skillId}" already exists outside the library; local files were kept`);
        currentHash = computeSkillSha256(await skillFilesOnDisk(skillDir));
        if (currentHash !== previous.sha256 && currentHash !== sha256) {
          throw new Error(`Skill "${skillId}" has local changes; local files were kept`);
        }
      }
      const entry = { pack, repo, commit, subpath, installedAt: new Date().toISOString(), sha256 };
      const backupDir = `${skillDir}.backup-${randomUUID()}`;
      let movedOld = false;
      let movedStage = false;
      try {
        if (exists && currentHash !== sha256) {
          await fs.rename(skillDir, backupDir);
          movedOld = true;
        }
        if (!exists || currentHash !== sha256) {
          await fs.rename(stageDir, skillDir);
          movedStage = true;
        }
        await recordProvenance(skillId, entry);
        await enableSkill(skillId);
      } catch (err) {
        if (movedStage) await fs.rm(skillDir, { recursive: true, force: true });
        if (movedOld) await fs.rename(backupDir, skillDir);
        if (previous) await recordProvenance(skillId, previous);
        else await removeProvenanceEntry(skillId);
        throw err;
      }
      if (movedOld) {
        await fs.rm(backupDir, { recursive: true, force: true }).catch((err) => {
          console.warn(`[skills] Could not remove retired backup for ${skillId}:`, err);
        });
      }
      return { skillId, path: skillDir, sha256, unchanged: exists && currentHash === sha256 };
    });
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch((err) => {
      console.warn(`[skills] Could not remove staging directory for ${skillId}:`, err);
    });
  }
}

/**
 * @param {import('../../../src/skills/library/registry.ts').SkillsLibraryPack} pack
 * @param {import('../../../src/skills/library/registry.ts').SkillsLibraryIndexSkill} indexSkill
 * @param {typeof fetch} [fetchImpl]
 */
export async function installPackSkill(pack, indexSkill, fetchImpl = fetch) {
  const { repo, commit } = pack.source;
  const files = await fetchSkillDirectoryFiles(repo, commit, indexSkill.subpath, fetchImpl);
  return installSkillTree({
    skillId: indexSkill.skillId,
    repo,
    commit,
    subpath: indexSkill.subpath,
    pack: pack.id,
    postInstallPatch: pack.postInstallPatch,
    files,
  });
}

/**
 * @param {string} repoUrl
 * @param {string} [subpathOverride]
 * @param {typeof fetch} [fetchImpl]
 */
export async function installSkillFromRepoUrl(repoUrl, subpathOverride, fetchImpl = fetch) {
  const parsed = parseGitHubRepoUrl(repoUrl);
  const subpath = (subpathOverride ?? parsed.subpath).replace(/^\/+|\/+$/g, '');
  const ref = parsed.ref ?? 'HEAD';
  const commit = await resolveCommitSha(parsed.repo, ref, fetchImpl);
  const files = await fetchSkillDirectoryFiles(parsed.repo, commit, subpath, fetchImpl);
  const skillId = resolveSkillIdFromFiles(files);

  return installSkillTree({
    skillId,
    repo: parsed.repo,
    commit,
    subpath,
    files,
  });
}

/**
 * @param {string} skillId
 */
export async function removeInstalledSkill(skillId) {
  if (!SKILL_ID_RE.test(skillId) || skillId.startsWith('_')) {
    throw new Error('Invalid skill id');
  }

  return withInstallMutation(async () => {
    const previous = (await readProvenance())[skillId];
    if (!previous) throw new Error(`Skill "${skillId}" is not tracked as a library install`);
    const skillDir = path.join(getUserSkillsRoot(), skillId);
    const exists = await directoryExists(skillDir);
    if (exists && computeSkillSha256(await skillFilesOnDisk(skillDir)) !== previous.sha256) {
      throw new Error(`Skill "${skillId}" has local changes; local files were kept`);
    }
    const backupDir = `${skillDir}.backup-${randomUUID()}`;
    if (exists) await fs.rename(skillDir, backupDir);
    try {
      await removeProvenanceEntry(skillId);
    } catch (err) {
      if (exists) await fs.rename(backupDir, skillDir);
      throw err;
    }
    if (exists) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch((err) => {
        console.warn(`[skills] Could not remove retired backup for ${skillId}:`, err);
      });
    }
    return { skillId, removed: true };
  });
}

/**
 * Remove every skill installed from a curated pack (provenance.pack match).
 * @param {string} packId
 */
export async function removePackInstalledSkills(packId) {
  const provenance = await readProvenance();
  const skillIds = Object.entries(provenance)
    .filter(([, entry]) => entry.pack === packId)
    .map(([id]) => id);

  const removed = [];
  const failed = [];
  for (const skillId of skillIds) {
    try {
      removed.push(await removeInstalledSkill(skillId));
    } catch (err) {
      failed.push({ skillId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, failed };
}
