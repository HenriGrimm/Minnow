/**
 * Agent-facing project memory tools: memory_search, memory_read, memory_save
 * and memory_forget. Every call is confined to the current project (keyed by
 * Git repository, shared by worktrees) and the user's cross-project scope.
 */

import { loadBrainConfig } from '../brain/store.js';
import { resolveMemoryProject } from '../brain/memory/scope.js';
import { searchMemories } from '../brain/memory/search.js';
import {
  MEMORY_KINDS,
  MemoryError,
  createMemory,
  forgetMemory,
  readMemory,
  updateMemory,
} from '../brain/memory/store.js';
import { getEffectiveWorkspaceRoot, getToolAbortSignal } from '../runtime/path-access.js';
import { recordBrainUsage } from '../brain/usage.js';

const DISABLED = 'Error: Agent memory is turned off (Brain → Memories). Continue without it.';

async function currentProject() {
  return resolveMemoryProject(getEffectiveWorkspaceRoot(), { signal: getToolAbortSignal() }).catch(error => {
    getToolAbortSignal()?.throwIfAborted();
    if (error?.name === 'AbortError') throw error;
    return null;
  });
}

async function guarded(work) {
  const brain = await loadBrainConfig();
  if (brain.enabled === false) return DISABLED;
  try {
    return await work(brain);
  } catch (error) {
    if (error instanceof MemoryError) return `Error: ${error.message}`;
    throw error;
  }
}

function stringList(value) {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.map(item => String(item).trim()).filter(Boolean);
}

/** memory_search — compact matches or an explicit "nothing found". */
export function toolMemorySearch(args) {
  return guarded(async brain => {
    const query = String(args?.query ?? '').trim();
    if (!query) return 'Error: query is required. Use specific words (a component, error text or decision topic).';
    const kind = args?.kind ? String(args.kind).trim().toLowerCase() : undefined;
    if (kind && !MEMORY_KINDS.includes(kind)) return `Error: kind must be one of: ${MEMORY_KINDS.join(', ')}.`;
    const project = await currentProject();
    const hits = await searchMemories({ query, limit: args?.limit, kind, project, signal: getToolAbortSignal() }, { config: brain });
    void recordBrainUsage('agent-read');
    if (!hits.length) return 'No matching memories.';
    const lines = hits.map(hit => `- ${hit.id} · ${hit.kind} · ${hit.scope} · ${hit.updated}\n  ${hit.title}\n  ${hit.summary}`);
    return `${hits.length} matching ${hits.length === 1 ? 'memory' : 'memories'} (read one with memory_read before relying on it):\n${lines.join('\n')}`;
  });
}

/** memory_read — full memory with revision. */
export function toolMemoryRead(args) {
  return guarded(async () => {
    const project = await currentProject();
    const memory = await readMemory(args?.id, { project });
    void recordBrainUsage('agent-read');
    const meta = memory.meta;
    return [
      `# ${meta.title}`,
      `id: ${meta.id}`,
      `revision: ${memory.revision}`,
      `kind: ${meta.kind ?? 'reference'}`,
      `scope: ${memory.scope}${memory.scope === 'project' && meta.projectLabel ? ` (${meta.projectLabel})` : ''}`,
      `updated: ${String(meta.updatedAt ?? '').slice(0, 10)}`,
      ...(meta.evidence ? [`evidence: ${meta.evidence}`] : []),
      ...(meta.supersedes?.length ? [`supersedes: ${meta.supersedes.join(', ')}`] : []),
      '',
      memory.body.trim() || '(empty)',
    ].join('\n');
  });
}

/** memory_save — create, or update when id is given. */
export function toolMemorySave(args, options = {}) {
  return guarded(async () => {
    const project = await currentProject();
    const id = String(args?.id ?? '').trim();
    const fields = {
      project,
      title: args?.title,
      body: args?.body,
      kind: args?.kind,
      evidence: args?.evidence,
      supersedes: stringList(args?.supersedes),
      scope: args?.scope,
    };
    if (id) {
      const updated = await updateMemory({ ...fields, id, expectedRevision: args?.expectedRevision }, { signal: getToolAbortSignal() });
      void recordBrainUsage('agent-write');
      return `Updated ${updated.scope} memory "${updated.meta.title}" (id: ${updated.meta.id}, revision: ${updated.revision}).`;
    }
    if (args?.expectedRevision) return 'Error: expectedRevision needs the id of the memory to update.';
    const created = await createMemory({
      ...fields,
      kind: args?.kind ?? 'reference',
      sourceChatId: typeof options.activityChatId === 'string' ? options.activityChatId : undefined,
    }, { signal: getToolAbortSignal() });
    void recordBrainUsage('agent-write');
    const where = created.scope === 'user' ? 'user memory' : `project memory${project?.label ? ` for ${project.label}` : ''}`;
    return `Saved ${where}: "${created.meta.title}" (id: ${created.meta.id}, revision: ${created.revision}).`;
  });
}

/** memory_forget — delete a wrong or obsolete memory. */
export function toolMemoryForget(args) {
  return guarded(async () => {
    const project = await currentProject();
    const reason = String(args?.reason ?? '').trim();
    if (!reason) return 'Error: reason is required (why the memory is wrong or no longer applies).';
    const gone = await forgetMemory({ project, id: args?.id, signal: getToolAbortSignal() });
    void recordBrainUsage('agent-write');
    return `Forgot ${gone.scope} memory "${gone.title}" (id: ${gone.id}). Reason: ${reason}`;
  });
}
