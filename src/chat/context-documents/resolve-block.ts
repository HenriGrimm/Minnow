import { wrapUntrusted } from '../../lib/untrusted.mjs';
import { CONTEXT_DOCUMENT_PRESETS } from './catalog';
import type { ContextDocumentsConfig } from './config';

export interface ContextDocumentReaders {
  readText(path: string): Promise<string | null>;
  listFiles(path: string): Promise<string[]>;
}

/** Shared selection, ordering and budgeting for browser and server preparation. */
export async function resolveContextDocumentsBlock(documents: ContextDocumentsConfig, io: ContextDocumentReaders): Promise<string> {
  const sections: Array<{ path: string; body: string }> = [];
  const seen = new Set<string>();
  async function add(path: string) {
    const key = path.toLowerCase();
    if (seen.has(key)) return true;
    const body = (await io.readText(path))?.trim();
    if (!body) return false;
    seen.add(key);
    sections.push({ path, body });
    return true;
  }
  const enabled = new Set(documents.enabledPresets);
  for (const preset of CONTEXT_DOCUMENT_PRESETS) {
    if (!enabled.has(preset.id)) continue;
    if (preset.directory) {
      const dir = preset.paths[0];
      if (!dir) continue;
      const files = (await io.listFiles(dir)).filter(name => /\.(md|mdc)$/i.test(name))
        .sort((a, b) => a.localeCompare(b));
      for (const name of files) await add(`${dir.replace(/\/+$/, '')}/${name}`);
    } else {
      for (const path of preset.paths) if (await add(path)) break;
    }
  }
  for (const raw of documents.customPaths) {
    const path = raw.trim().replace(/\\/g, '/');
    if (path) await add(path);
  }
  const parts: string[] = [];
  let used = 0;
  for (const { path, body } of sections) {
    const chunk = `### ${path}\n\n${body}`;
    const remaining = documents.maxTotalChars - used;
    if (remaining <= 0) break;
    if (chunk.length <= remaining) {
      parts.push(chunk); used += chunk.length;
    } else {
      parts.push(`${chunk.slice(0, remaining)}\n\n[… truncated — context document budget exceeded]`);
      break;
    }
  }
  const joined = parts.join('\n\n');
  return joined.trim() ? wrapUntrusted(joined, { source: 'context-documents' }) : '';
}
