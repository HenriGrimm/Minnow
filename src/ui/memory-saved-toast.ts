import type { BrainPage } from '../brain/types';
import type { MemoryEntryMeta } from '../memory/types';
import { notify, type NotifyHandle } from './toast';

/** Reject only makes sense right after the save, so this card stays a little longer. */
const DEFAULT_DURATION_MS = 8000;
const DESCRIPTION_MAX_LENGTH = 160;

export type MemorySavedTarget =
  | { kind: 'page'; relPath: string }
  | { kind: 'memory'; id: string };

export interface MemorySavedPayload {
  title: string;
  description: string;
  target: MemorySavedTarget;
}

export interface MemorySavedToastOptions {
  durationMs?: number;
  onOpen?: (payload: MemorySavedPayload) => void | Promise<void>;
  onReject?: (payload: MemorySavedPayload) => boolean | void | Promise<boolean | void>;
}

const handles = new Set<NotifyHandle>();

/** Convert markdown-like memory content into a compact plain-text description. */
export function memorySavedDescription(text: unknown, fallback = 'Saved to Brain.'): string {
  if (typeof text !== 'string') {
    return fallback;
  }

  const normalized = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[\s>#*`~_-]+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return fallback;
  }
  if (normalized.length <= DESCRIPTION_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`;
}

/** Build a card payload from the canonical Brain page response. */
export function memorySavedPayloadFromBrainPage(page: BrainPage): MemorySavedPayload {
  return {
    title: page.meta.title || 'Untitled memory',
    description: memorySavedDescription(page.meta.summary || page.body),
    target: { kind: 'page', relPath: page.path },
  };
}

/** Build a card payload from a legacy memory entry and its submitted body. */
export function memorySavedPayloadFromEntry(
  entry: MemoryEntryMeta,
  body: string,
): MemorySavedPayload {
  return {
    title: entry.title || 'Untitled memory',
    description: memorySavedDescription(body),
    target: { kind: 'memory', id: entry.id },
  };
}

function readStringArg(args: unknown, key: string): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return '';
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Parse successful memory tool output into a card payload. */
export function memorySavedPayloadFromTool(
  toolName: string,
  args: unknown,
  result: string,
): MemorySavedPayload | null {
  if (result.trimStart().startsWith('Error')) {
    return null;
  }

  const id = result.match(/\(id:\s*([0-9a-f-]{36})\)/i)?.[1];
  if (!id) {
    return null;
  }

  const title = readStringArg(args, 'title') || 'Untitled memory';
  const description = memorySavedDescription(
    readStringArg(args, 'summary') || readStringArg(args, 'body'),
  );

  if (toolName === 'save_memory' && result.startsWith('Saved memory')) {
    return {
      title,
      description,
      target: { kind: 'memory', id },
    };
  }

  if (toolName === 'brain_write_page' && /^(Created|Updated) wiki page/.test(result)) {
    const relPath = readStringArg(args, 'path').replace(/\\/g, '/');
    if (!relPath) {
      return null;
    }
    return {
      title,
      description,
      target: { kind: 'page', relPath },
    };
  }

  return null;
}

async function openSavedMemory(payload: MemorySavedPayload): Promise<void> {
  const { openBrain, openBrainEditForPath } = await import('./brain-page');
  if (payload.target.kind === 'page') {
    openBrainEditForPath(payload.target.relPath);
    return;
  }
  openBrain('memories');
}

async function rejectSavedMemory(payload: MemorySavedPayload): Promise<boolean> {
  if (payload.target.kind === 'memory') {
    const { deleteMemoryEntry } = await import('../memory/client');
    return deleteMemoryEntry(payload.target.id);
  }

  const { deleteBrainPage } = await import('../brain/client');
  const result = await deleteBrainPage(payload.target.relPath);
  return result.ok;
}

/** Show the shared notification card for a saved memory. */
export function showMemorySavedToast(
  payload: MemorySavedPayload,
  options: MemorySavedToastOptions = {},
): () => void {
  const snapshot: MemorySavedPayload = {
    title: payload.title,
    description: payload.description,
    target: { ...payload.target },
  };
  const open = (): void => {
    if (options.onOpen) void options.onOpen(snapshot);
    else void openSavedMemory(snapshot);
  };
  const targetKey = snapshot.target.kind === 'page' ? snapshot.target.relPath : snapshot.target.id;
  const handle = notify({
    tone: 'success',
    icon: 'brainMemories',
    source: 'Brain',
    context: 'Memory saved',
    title: snapshot.title,
    message: snapshot.description,
    durationMs: options.durationMs ?? DEFAULT_DURATION_MS,
    open,
    openLabel: 'Open memory',
    dedupeKey: `memory-saved:${snapshot.target.kind}:${targetKey}`,
    actions: [
      {
        label: 'Reject',
        variant: 'danger',
        ariaLabel: `Reject memory ${snapshot.title}`,
        run: async () => {
          const result = options.onReject
            ? await options.onReject(snapshot)
            : await rejectSavedMemory(snapshot);
          if (result === false) throw new Error('Could not reject this memory. Try again.');
          return { tone: 'success', icon: 'check', message: 'Memory rejected' };
        },
      },
    ],
    onDismiss: () => {
      if (handle) handles.delete(handle);
    },
  });
  if (!handle) return () => {};
  handles.add(handle);
  return () => {
    handles.delete(handle);
    handle.dismiss();
  };
}

/** Show a card only when the completed tool result confirms a successful save. */
export function notifyMemorySavedFromTool(
  toolName: string,
  args: unknown,
  result: string,
): void {
  const payload = memorySavedPayloadFromTool(toolName, args, result);
  if (payload) {
    showMemorySavedToast(payload);
  }
}

/** Clear global card state during teardown and deterministic tests. */
export function dismissAllMemorySavedToasts(): void {
  for (const handle of [...handles]) handle.dismiss();
  handles.clear();
}
