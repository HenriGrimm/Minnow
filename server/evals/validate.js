/**
 * Server-side eval pack validation (mirrors client pack-schema rules).
 */

import { BUILT_IN_TOOLS } from '../tools/builtin-catalog.js';
import { validateEvalToolFixtures } from './tool-fixtures.js';

const PACK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const KNOWN_TOOL_IDS = new Set(BUILT_IN_TOOLS.map(tool => tool.id));

function isStringArray(value) {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function validateTask(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`tasks[${index}]: must be an object`);
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!TASK_ID_RE.test(id)) {
    throw new Error(`tasks[${index}].id: invalid id "${id}"`);
  }
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) throw new Error(`tasks[${index}].prompt: required`);
  const allowedTools = isStringArray(raw.allowedTools)
    ? raw.allowedTools.map((s) => s.trim())
    : [];
  const deniedTools = isStringArray(raw.deniedTools)
    ? raw.deniedTools.map((s) => s.trim())
    : [];
  for (const toolId of [...allowedTools, ...deniedTools]) {
    if (!KNOWN_TOOL_IDS.has(toolId)) {
      throw new Error(`tasks[${index}]: unknown tool "${toolId}"`);
    }
  }
  const rubricPrompt =
    typeof raw.rubricPrompt === 'string' ? raw.rubricPrompt.trim() : '';
  if (!rubricPrompt) throw new Error(`tasks[${index}].rubricPrompt: required`);
  const systemPrompt =
    typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim()
      ? raw.systemPrompt.trim()
      : undefined;

  return {
    id,
    prompt,
    systemPrompt,
    allowedTools,
    deniedTools,
    rubricPrompt,
    ...(raw.toolFixtures === undefined ? {} : { toolFixtures: validateEvalToolFixtures(raw.toolFixtures, allowedTools, deniedTools, KNOWN_TOOL_IDS) }),
  };
}

/** @param {unknown} raw */
export function validateEvalPack(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Pack must be an object');
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!PACK_ID_RE.test(id)) {
    throw new Error(`Pack id invalid: "${id}"`);
  }
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) throw new Error('Pack label is required');
  const version =
    typeof raw.version === 'number' && Number.isFinite(raw.version)
      ? Math.max(1, Math.floor(raw.version))
      : 1;
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error('Pack tasks array is required');
  }
  const tasks = raw.tasks.map((task, index) => validateTask(task, index));
  const taskIds = new Set();
  for (const task of tasks) {
    if (taskIds.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    taskIds.add(task.id);
  }
  return { id, label, version, tasks };
}
