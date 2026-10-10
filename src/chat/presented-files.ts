import type { Chat } from '../types';

export interface PresentedFile {
  path: string;
  name: string;
  title: string;
  bytes: number;
  workspaceRoot: string;
}

/** Only versioned present_files results are eligible for file cards. */
export function parsePresentedFiles(content: string): PresentedFile[] {
  try {
    const value = JSON.parse(content);
    if (value?.kind !== 'presented-files' || value.version !== 1
      || typeof value.workspaceRoot !== 'string' || !/^(?:[A-Za-z]:\/|\/)/.test(value.workspaceRoot.replace(/\\/g, '/'))
      || value.workspaceRoot.includes('\0') || !Array.isArray(value.files)
      || value.files.length < 1 || value.files.length > 20) return [];
    const files: PresentedFile[] = [];
    for (const file of value.files) {
      if (!file || typeof file.path !== 'string' || !file.path.trim() || file.path.includes('\0')
        || typeof file.name !== 'string' || !file.name || typeof file.title !== 'string'
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return [];
      files.push({ path: file.path, name: file.name, title: file.title || file.name,
        bytes: file.bytes, workspaceRoot: value.workspaceRoot });
    }
    return files;
  } catch { return []; }
}

/** Reconstruct handoffs from saved history, preserving each result's original workspace. */
export function getTurnPresentedFiles(chat: Chat, start: number, end: number): PresentedFile[] {
  const calls = new Set<string>();
  const files = new Map<string, PresentedFile>();
  for (let i = start; i <= end; i++) {
    const message = chat.history[i];
    if (message?.role === 'assistant' && 'tool_calls' in message) {
      for (const call of message.tool_calls ?? []) {
        if (call.function.name === 'present_files') calls.add(call.id);
      }
    } else if (message?.role === 'tool' && calls.has(message.tool_call_id)) {
      for (const file of parsePresentedFiles(message.content)) {
        files.set(`${file.workspaceRoot}\0${file.path}`, file);
      }
    }
  }
  return [...files.values()];
}
