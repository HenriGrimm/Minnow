/**
 * Runtime validation for eval task packs.
 */

import { BUILT_IN_TOOLS } from '../tools/definitions';
import type { EvalPack, EvalTask } from './types';
import { validateEvalToolFixtures } from '../../server/evals/tool-fixtures.js';

const PACK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

const KNOWN_TOOL_IDS = new Set(BUILT_IN_TOOLS.map((t) => t.id));

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function validateTask(raw: unknown, index: number): EvalTask {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`tasks[${index}]: must be an object`);
  }
  const t = raw as Record<string, unknown>;
  const id = typeof t.id === 'string' ? t.id.trim() : '';
  if (!TASK_ID_RE.test(id)) {
    throw new Error(`tasks[${index}].id: invalid id "${id}"`);
  }
  const prompt = typeof t.prompt === 'string' ? t.prompt.trim() : '';
  if (!prompt) {
    throw new Error(`tasks[${index}].prompt: required`);
  }
  const allowedTools = isStringArray(t.allowedTools) ? t.allowedTools.map((s) => s.trim()) : [];
  const deniedTools = isStringArray(t.deniedTools) ? t.deniedTools.map((s) => s.trim()) : [];
  for (const toolId of [...allowedTools, ...deniedTools]) {
    if (!KNOWN_TOOL_IDS.has(toolId)) {
      throw new Error(`tasks[${index}]: unknown tool "${toolId}"`);
    }
  }
  const rubricPrompt = typeof t.rubricPrompt === 'string' ? t.rubricPrompt.trim() : '';
  if (!rubricPrompt) {
    throw new Error(`tasks[${index}].rubricPrompt: required`);
  }
  const systemPrompt =
    typeof t.systemPrompt === 'string' && t.systemPrompt.trim()
      ? t.systemPrompt.trim()
      : undefined;

  return {
    id,
    prompt,
    systemPrompt,
    allowedTools,
    deniedTools,
    rubricPrompt,
    ...(t.toolFixtures === undefined ? {} : { toolFixtures: validateEvalToolFixtures(t.toolFixtures, allowedTools, deniedTools, KNOWN_TOOL_IDS) }),
  };
}

/** Validate and normalize a pack JSON object. */
export function validateEvalPack(raw: unknown): EvalPack {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Pack must be an object');
  }
  const p = raw as Record<string, unknown>;
  const id = typeof p.id === 'string' ? p.id.trim() : '';
  if (!PACK_ID_RE.test(id)) {
    throw new Error(`Pack id invalid: "${id}"`);
  }
  const label = typeof p.label === 'string' ? p.label.trim() : '';
  if (!label) {
    throw new Error('Pack label is required');
  }
  const version =
    typeof p.version === 'number' && Number.isFinite(p.version)
      ? Math.max(1, Math.floor(p.version))
      : 1;
  if (!Array.isArray(p.tasks) || p.tasks.length === 0) {
    throw new Error('Pack tasks array is required and must not be empty');
  }
  const tasks = p.tasks.map((task, index) => validateTask(task, index));
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    taskIds.add(task.id);
  }
  return { id, label, version, tasks };
}
