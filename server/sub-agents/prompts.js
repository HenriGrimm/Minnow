import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMinnowHome } from '../config/home.js';
import { readPromptFile } from '../prompts/file-overrides.js';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * @param {string} typeId
 * @param {Record<string, unknown>} typeRow
 * @param {string} task
 * @param {'full' | 'lite'} [profile]
 * @returns {Promise<string>}
 */
export async function loadSubAgentSystemPrompt(typeId, typeRow, task, profile = 'full') {
  const base = await resolveBasePrompt(typeId, typeRow, profile);
  return `${base}

---

You are a sub-agent (type: ${typeId}). Complete the following task. You cannot spawn other sub-agents.
When finished, call the report tool with a verdict. Do not put the outcome only in assistant text.

Task:
${task}`;
}

/**
 * @param {string} typeId
 * @param {Record<string, unknown>} typeRow
 * @param {'full' | 'lite'} profile
 * @returns {Promise<string>}
 */
async function resolveBasePrompt(typeId, typeRow, profile) {
  const overridePath = typeof typeRow.systemPromptPath === 'string' ? typeRow.systemPromptPath.trim() : '';
  if (overridePath) {
    const fromPath = await readPromptPath(overridePath);
    if (fromPath) return fromPath;
  }

  const workAgentId = typeof typeRow.workAgentId === 'string' ? typeRow.workAgentId.trim() : '';
  if (workAgentId) {
    const fromWork = await readWorkAgentPrompt(workAgentId, profile);
    if (fromWork) return fromWork;
  }

  try {
    const shipped = await readPromptFile(PROJECT_ROOT, 'sub-agents', typeId, profile);
    if (shipped?.content?.trim()) return shipped.content.trim();
  } catch {
    /* unknown type id, or no markdown on disk */
  }

  return `You are a focused sub-agent (${typeId}). Complete tasks efficiently and return a concise summary.`;
}

/** Reuse role instructions in durable chats without the legacy task/report wrapper. */
export { resolveBasePrompt as resolveSubAgentBasePrompt };

/**
 * @param {string} rawPath
 * @returns {Promise<string | null>}
 */
async function readPromptPath(rawPath) {
  const candidates = [];
  if (path.isAbsolute(rawPath)) candidates.push(rawPath);
  else {
    candidates.push(path.join(getMinnowHome(), rawPath));
    candidates.push(path.join(PROJECT_ROOT, rawPath));
  }
  for (const candidate of candidates) {
    try {
      const text = await fs.readFile(candidate, 'utf8');
      const trimmed = text.trim();
      if (trimmed) return trimmed;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

/**
 * @param {string} workAgentId
 * @param {'full' | 'lite'} profile
 * @returns {Promise<string | null>}
 */
async function readWorkAgentPrompt(workAgentId, profile) {
  const file = path.join(
    PROJECT_ROOT,
    'src',
    'chat',
    'prompts',
    'work-agents',
    workAgentId,
    `agent.${profile}.md`,
  );
  try {
    const text = await fs.readFile(file, 'utf8');
    const trimmed = text.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}
