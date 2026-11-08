/**
 * Read/write shipped prompt files and ~/.minnow user overrides (modes, experts, sub-agents).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { invalidateNativePolicyBeforeWrite } from '../chats/native-policy-monitor.js';
import { parsePromptMarkdown } from './parse.js';

const ENTITY_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * @param {string} id
 */
export function assertValidPromptEntityId(id) {
  if (!id || typeof id !== 'string' || !ENTITY_ID_RE.test(id)) {
    throw new Error('Invalid id');
  }
}

/**
 * @param {'modes'|'experts'|'sub-agents'|'base'|'tool-usage'|'info'} family
 * @param {string} entityId
 * @param {'full'|'lite'} profile
 */
/** Agent prompt parts editable in Settings → Agents (one agent; see prompt-composer). */
export const AGENT_PROMPT_FAMILIES = Object.freeze(['base', 'tool-usage', 'info']);

function builtinRelativePath(family, entityId, profile) {
  if (AGENT_PROMPT_FAMILIES.includes(family)) {
    return path.join('src', 'chat', 'prompts', family, `${entityId}.${profile}.md`);
  }
  if (family === 'modes') {
    return path.join('src', 'chat', 'prompts', 'modes', `${entityId}.${profile}.md`);
  }
  if (family === 'experts') {
    return path.join(
      'src',
      'chat',
      'prompts',
      'experts',
      entityId,
      `expert.${profile}.md`,
    );
  }
  return path.join('src', 'agents', 'prompts', 'sub-agents', `${entityId}.${profile}.md`);
}

/**
 * @param {'modes'|'experts'|'sub-agents'|'base'|'tool-usage'|'info'} family
 * @param {string} entityId
 * @param {'full'|'lite'} profile
 */
function userRelativePath(family, entityId, profile) {
  if (AGENT_PROMPT_FAMILIES.includes(family)) {
    return path.join('prompts', family, `${entityId}.${profile}.md`);
  }
  if (family === 'modes') {
    return path.join('prompts', 'modes', `${entityId}.${profile}.md`);
  }
  if (family === 'experts') {
    return path.join('prompts', 'experts', entityId, `expert.${profile}.md`);
  }
  return path.join('prompts', 'sub-agents', `${entityId}.${profile}.md`);
}

function resolveUnderRoot(root, rel) {
  const full = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (full !== root && !full.startsWith(rootWithSep)) {
    throw new Error('Invalid path');
  }
  return full;
}

function extractBody(raw, filePath) {
  try {
    const parsed = parsePromptMarkdown(raw, filePath);
    return parsed.body.trim();
  } catch {
    return raw.trim();
  }
}

/**
 * @param {string} projectRoot
 * @param {'modes'|'experts'|'sub-agents'|'base'|'tool-usage'|'info'} family
 * @param {string} entityId
 * @param {'full'|'lite'} profile
 */
/**
 * Shipped repo prompt only (ignores ~/.minnow overrides).
 * @param {string} projectRoot
 * @param {'modes'|'experts'|'sub-agents'|'base'|'tool-usage'|'info'} family
 * @param {string} entityId
 * @param {'full'|'lite'} profile
 */
export async function readBuiltinPromptFile(projectRoot, family, entityId, profile) {
  assertValidPromptEntityId(entityId);
  if (profile !== 'full' && profile !== 'lite') {
    throw new Error('Invalid profile');
  }

  let builtinPath = resolveUnderRoot(
    path.resolve(projectRoot),
    builtinRelativePath(family, entityId, profile),
  );
  // One prompt serves every profile (D7): a missing lite file falls back to full.
  if (profile === 'lite' && AGENT_PROMPT_FAMILIES.includes(family)) {
    try { await fs.access(builtinPath); }
    catch { builtinPath = resolveUnderRoot(path.resolve(projectRoot), builtinRelativePath(family, entityId, 'full')); }
  }
  const raw = await fs.readFile(builtinPath, 'utf8');
  return { content: extractBody(raw, builtinPath), source: 'builtin' };
}

/**
 * @param {string} projectRoot
 * @param {'modes'|'experts'|'sub-agents'|'base'|'tool-usage'|'info'} family
 * @param {string} entityId
 * @param {'full'|'lite'} profile
 * @param {{ raw?: boolean }} [options]
 */
export async function readPromptFile(projectRoot, family, entityId, profile, options = {}) {
  assertValidPromptEntityId(entityId);
  if (profile !== 'full' && profile !== 'lite') {
    throw new Error('Invalid profile');
  }

  const home = path.resolve(getMinnowHome());
  const userPath = resolveUnderRoot(home, userRelativePath(family, entityId, profile));

  try {
    const raw = await fs.readFile(userPath, 'utf8');
    if (options.raw) {
      return { content: raw, source: 'override' };
    }
    return { content: extractBody(raw, userPath), source: 'override' };
  } catch {
    /* fall through */
  }

  if (options.raw) {
    const builtinPath = resolveUnderRoot(
      path.resolve(projectRoot),
      builtinRelativePath(family, entityId, profile),
    );
    const rawBuiltin = await fs.readFile(builtinPath, 'utf8');
    return { content: rawBuiltin, source: 'builtin' };
  }

  return readBuiltinPromptFile(projectRoot, family, entityId, profile);
}

/**
 * Remove ~/.minnow/prompts/experts/<entityId>/ (user-created expert).
 * @param {string} entityId
 */
export async function deleteExpertEntityDir(entityId) {
  assertValidPromptEntityId(entityId);
  const home = path.resolve(getMinnowHome());
  const dirPath = resolveUnderRoot(home, path.join('prompts', 'experts', entityId));
  try {
    invalidateNativePolicyBeforeWrite('prompts');
    await fs.rm(dirPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {'modes'|'experts'|'sub-agents'|'base'|'tool-usage'|'info'} family
 * @param {string} entityId
 * @param {'full'|'lite'} profile
 * @param {string} content
 */
export async function writePromptFileOverride(family, entityId, profile, content) {
  assertValidPromptEntityId(entityId);
  if (profile !== 'full' && profile !== 'lite') {
    throw new Error('Invalid profile');
  }

  const home = path.resolve(getMinnowHome());
  const filePath = resolveUnderRoot(home, userRelativePath(family, entityId, profile));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let body =
    typeof content === 'string' && content.trim() ? `${content.trim()}\n` : '';
  // Agent parts merge through the prompt registry, which needs an id and kind.
  if (body && AGENT_PROMPT_FAMILIES.includes(family) && !body.startsWith('---')) {
    body = `---\nid: ${entityId}\nkind: ${family}\nlabel: ${JSON.stringify(entityId)}\nversion: 1\npart: ${family === 'info' ? 'info' : family}\n---\n\n${body}`;
  }
  invalidateNativePolicyBeforeWrite('prompts');
  await fs.writeFile(filePath, body, 'utf8');
  return filePath;
}

/**
 * Remove user override so built-in ships again.
 */
export async function deletePromptFileOverride(family, entityId, profile) {
  assertValidPromptEntityId(entityId);
  const home = path.resolve(getMinnowHome());
  const filePath = resolveUnderRoot(home, userRelativePath(family, entityId, profile));
  try {
    invalidateNativePolicyBeforeWrite('prompts');
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}
