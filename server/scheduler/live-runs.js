/**
 * Live state for scheduled runs.
 *
 * Headless runs stream runner events as JSON lines (`--stream-json`). This
 * module folds those events into chat-history messages — the same shape the
 * chat renderer paints — plus a one-line "current step" and counters for the
 * Automations hub. Finished transcripts are persisted next to run history so
 * a run can be read later without the session store.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { schedulerRunsDir } from './paths.js';
import { renameSchedulerFile } from './atomic-file.js';

const MAX_MESSAGES = 400;
const MAX_TOOL_CONTENT = 12_000;
const MAX_TEXT = 40_000;
/** Finished live entries linger briefly so a poll can observe the terminal state. */
const FINISHED_TTL_MS = 30_000;

const READ_TOOLS = new Set(['read_file', 'read_files', 'view_file', 'list_directory', 'grep', 'search_files', 'glob', 'find_files', 'lsp_definition', 'lsp_references']);
const EDIT_TOOLS = new Set(['write_file', 'save_file', 'edit_file', 'apply_patch', 'replace_in_file', 'str_replace', 'multi_edit', 'create_file', 'delete_file']);
const COMMAND_TOOLS = new Set(['execute_command', 'run_command', 'shell', 'terminal_run']);

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}\n… (${value.length - max} more characters)` : value;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw ?? '{}')); } catch { return {}; }
}

/** One short phrase describing a tool call, e.g. "npm test" or "src/boids.js". */
export function describeToolTarget(name, rawArgs) {
  const args = parseArgs(rawArgs);
  const pick = args.command ?? args.cmd ?? args.path ?? args.file ?? args.file_path ?? args.paths?.[0] ?? args.pattern ?? args.query ?? args.url;
  const target = typeof pick === 'string' ? pick.replace(/\s+/g, ' ').trim() : '';
  return target ? `${name} › ${target.slice(0, 140)}` : name;
}

/**
 * Fold runner events into chat history. Pure; exported for tests.
 * @param {{ prompt?: string; label?: string }} [opening]
 */
export function createTranscriptBuilder(opening = {}) {
  /** @type {any[]} */
  const messages = [];
  if (opening.prompt) messages.push({ role: 'user', content: clip(opening.prompt, MAX_TEXT) });
  const live = { lastDelta: '', lastThinking: '', currentTool: /** @type {string | null} */ (null), phase: /** @type {string | null} */ ('loading_model') };
  const stats = { rounds: 0, toolCalls: 0, filesRead: 0, filesEdited: 0, commands: 0 };
  let step = 'Starting';
  let callSeq = 0;
  /** @type {any} */
  let roundAssistant = null;
  /** Tool calls in arrival order that are still waiting for a result. */
  const pending = [];

  function push(message) {
    messages.push(message);
    if (messages.length > MAX_MESSAGES) messages.splice(opening.prompt ? 1 : 0, messages.length - MAX_MESSAGES);
  }

  function assistantForTools() {
    if (roundAssistant && roundAssistant.closed && Array.isArray(roundAssistant.message.tool_calls)) return roundAssistant.message;
    if (roundAssistant?.closed) {
      roundAssistant.message.tool_calls = [];
      return roundAssistant.message;
    }
    const message = { role: 'assistant', content: live.lastDelta || null, tool_calls: [] };
    push(message);
    roundAssistant = { message, closed: true };
    return message;
  }

  return {
    /** @param {any} event */
    apply(event) {
      if (!event || typeof event.type !== 'string') return;
      switch (event.type) {
        case 'loading_model': live.phase = 'loading_model'; step = 'Loading model'; break;
        case 'phase': live.phase = event.phase ?? live.phase; break;
        case 'round_start':
          live.lastDelta = ''; live.lastThinking = ''; live.currentTool = null; live.phase = 'thinking';
          roundAssistant = null;
          break;
        case 'thinking':
          live.lastThinking = clip(event.text, MAX_TEXT); live.phase = 'thinking';
          if (!live.lastDelta) step = 'Thinking';
          break;
        case 'delta':
          live.lastDelta = clip(event.text, MAX_TEXT); live.phase = 'generating'; live.currentTool = null;
          step = live.lastDelta.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 160) || 'Writing';
          break;
        case 'tool_streaming':
          live.currentTool = event.name; live.phase = 'tools'; step = `Preparing ${event.name}`;
          break;
        case 'round_end': {
          stats.rounds += 1;
          const message = { role: 'assistant', content: clip(event.text ?? live.lastDelta, MAX_TEXT) };
          if (event.reasoning) { message.thinking = [clip(event.reasoning, MAX_TEXT)]; if (event.reasoningFormat) message.reasoningFormat = event.reasoningFormat; }
          if (event.toolCallCount > 0) message.tool_calls = [];
          if (message.content || message.thinking || message.tool_calls) push(message);
          roundAssistant = { message, closed: true };
          live.lastDelta = ''; live.lastThinking = ''; live.currentTool = null;
          live.phase = event.toolCallCount > 0 ? 'tools' : 'waiting';
          break;
        }
        case 'tool_call': {
          stats.toolCalls += 1;
          if (READ_TOOLS.has(event.name)) stats.filesRead += 1;
          if (EDIT_TOOLS.has(event.name)) stats.filesEdited += 1;
          if (COMMAND_TOOLS.has(event.name)) stats.commands += 1;
          const id = String(event.id || `call_${++callSeq}`);
          const args = typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments ?? {});
          assistantForTools().tool_calls.push({ id, type: 'function', function: { name: event.name, arguments: clip(args, MAX_TOOL_CONTENT) } });
          pending.push({ id, name: event.name });
          live.currentTool = event.name; live.phase = 'tools';
          step = describeToolTarget(event.name, event.arguments);
          break;
        }
        case 'tool_result': {
          const index = event.id ? pending.findIndex((row) => row.id === event.id) : pending.findIndex((row) => row.name === event.name);
          const call = index >= 0 ? pending.splice(index, 1)[0] : { id: String(event.id || `call_${++callSeq}`), name: event.name };
          const message = { role: 'tool', tool_call_id: call.id, content: clip(event.content, MAX_TOOL_CONTENT) };
          if (event.codeChange) message.codeChange = event.codeChange;
          push(message);
          live.currentTool = pending.at(-1)?.name ?? null;
          break;
        }
        default: break;
      }
    },
    /** Add the opening user message after the builder was created. */
    setOpening(prompt) {
      if (!prompt || messages[0]?.role === 'user') return;
      messages.unshift({ role: 'user', content: clip(prompt, MAX_TEXT) });
      opening.prompt = prompt;
    },
    messages: () => messages,
    live: () => ({ ...live }),
    stats: () => ({ ...stats }),
    step: () => step,
    /** Close dangling tool calls so a finished transcript always pairs calls with results. */
    seal(note) {
      for (const call of pending.splice(0)) push({ role: 'tool', tool_call_id: call.id, content: note || 'Run ended before this tool returned.' });
      live.lastDelta = ''; live.lastThinking = ''; live.currentTool = null; live.phase = null;
    },
  };
}

/** @type {Map<string, any>} */
const liveRuns = new Map();

/**
 * Register a run that is about to start.
 * @param {{ runId: string; jobId: string; label: string; prompt?: string; parentRunId?: string; role?: string; roleLabel?: string; workspacePath?: string; chatId?: string }} input
 */
export function beginLiveRun(input) {
  const entry = {
    runId: input.runId,
    jobId: input.jobId,
    label: input.label,
    parentRunId: input.parentRunId,
    role: input.role,
    roleLabel: input.roleLabel,
    workspacePath: input.workspacePath,
    chatId: input.chatId ?? input.runId,
    startedAt: new Date().toISOString(),
    status: 'running',
    builder: createTranscriptBuilder({ prompt: input.prompt }),
    /** Engine-level headline (e.g. "Reviewing #142"), set by presets. */
    headline: undefined,
    /** First sentence of the instructions, for prompt runs. */
    brief: undefined,
    /** Engine-level focus item for the hub card. */
    focus: undefined,
    result: undefined,
    finishedAt: undefined,
  };
  liveRuns.set(input.runId, entry);
  return entry;
}

/** @param {string} runId @param {any} event */
export function applyLiveEvent(runId, event) {
  liveRuns.get(runId)?.builder.apply(event);
}

/** @param {string} runId @param {string} prompt */
export function setLiveRunOpening(runId, prompt) {
  const entry = liveRuns.get(runId);
  if (!entry) return;
  entry.builder.setOpening(prompt);
  const first = String(prompt ?? '').trim().split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? '';
  entry.brief = first.length > 120 ? `${first.slice(0, 117).trim()}…` : first;
}

/** @param {string} runId @param {{ headline?: string; focus?: any }} patch */
export function setLiveRunHeadline(runId, patch) {
  const entry = liveRuns.get(runId);
  if (!entry) return;
  if (patch.headline !== undefined) entry.headline = patch.headline;
  if (patch.focus !== undefined) entry.focus = patch.focus;
}

/**
 * Mark a live run finished. It stays visible for a short time.
 * @param {string} runId
 * @param {{ status: string; result?: any; note?: string }} outcome
 */
export function finishLiveRun(runId, outcome) {
  const entry = liveRuns.get(runId);
  if (!entry) return null;
  entry.builder.seal(outcome.note);
  entry.status = outcome.status;
  entry.result = outcome.result;
  entry.finishedAt = new Date().toISOString();
  const timer = setTimeout(() => {
    if (liveRuns.get(runId) === entry) liveRuns.delete(runId);
  }, FINISHED_TTL_MS);
  timer.unref?.();
  return entry;
}

/** @param {any} entry @param {{ withMessages?: boolean }} [options] */
function project(entry, options = {}) {
  const children = [...liveRuns.values()].filter((row) => row.parentRunId === entry.runId).map((row) => project(row));
  return {
    runId: entry.runId,
    jobId: entry.jobId,
    label: entry.label,
    parentRunId: entry.parentRunId,
    role: entry.role,
    roleLabel: entry.roleLabel,
    chatId: entry.chatId,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    status: entry.status,
    step: entry.builder.step(),
    headline: entry.headline,
    brief: entry.brief,
    focus: entry.focus,
    stats: entry.builder.stats(),
    result: entry.result,
    live: entry.status === 'running' ? entry.builder.live() : null,
    children,
    ...(options.withMessages ? { messages: entry.builder.messages() } : {}),
  };
}

/** Top-level runs still working (reviewer sub-runs are nested under their parent). */
export function listLiveRuns() {
  return [...liveRuns.values()].filter((row) => !row.parentRunId && row.status === 'running').map((row) => project(row));
}

/** @param {string} runId */
export function getLiveRun(runId, options = { withMessages: true }) {
  const entry = liveRuns.get(runId);
  return entry ? project(entry, options) : null;
}

/** @param {string} runId */
export function getLiveTranscriptMessages(runId) {
  return liveRuns.get(runId)?.builder.messages() ?? null;
}

/** Test hook. */
export function resetLiveRunsForTests() {
  liveRuns.clear();
}

// ---------- persisted transcripts ----------

function transcriptDir(jobId) {
  return path.join(schedulerRunsDir(), 'transcripts', String(jobId).replace(/[^A-Za-z0-9_-]/g, '_'));
}

function transcriptPath(jobId, runId) {
  return path.join(transcriptDir(jobId), `${String(runId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

/**
 * Persist a finished run's transcript (and its sub-run transcripts).
 * @param {string} jobId
 * @param {string} runId
 */
export async function persistRunTranscript(jobId, runId) {
  const entry = liveRuns.get(runId);
  if (!entry) return;
  const children = [...liveRuns.values()].filter((row) => row.parentRunId === runId);
  const payload = {
    version: 1,
    runId,
    jobId,
    label: entry.label,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt ?? new Date().toISOString(),
    status: entry.status,
    headline: entry.headline,
    focus: entry.focus,
    stats: entry.builder.stats(),
    messages: entry.builder.messages(),
    children: children.map((child) => ({
      runId: child.runId,
      role: child.role,
      roleLabel: child.roleLabel,
      chatId: child.chatId,
      status: child.status,
      startedAt: child.startedAt,
      finishedAt: child.finishedAt,
      result: child.result,
      stats: child.builder.stats(),
      messages: child.builder.messages(),
    })),
  };
  const target = transcriptPath(jobId, runId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
  await renameSchedulerFile(tmp, target);
}

/** @param {string} jobId @param {string} runId */
export async function readRunTranscript(jobId, runId) {
  try {
    return JSON.parse(await fs.readFile(transcriptPath(jobId, runId), 'utf8'));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/** Remove transcripts whose run rows were pruned from history. */
export async function pruneRunTranscripts(jobId, keepRunIds) {
  const keep = new Set([...keepRunIds].map((id) => `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.json`));
  let names = [];
  try { names = await fs.readdir(transcriptDir(jobId)); } catch { return; }
  await Promise.all(names.filter((name) => name.endsWith('.json') && !keep.has(name))
    .map((name) => fs.rm(path.join(transcriptDir(jobId), name), { force: true })));
}

/** Remove every transcript for a deleted job. */
export async function removeJobTranscripts(jobId) {
  await fs.rm(transcriptDir(jobId), { recursive: true, force: true });
}
