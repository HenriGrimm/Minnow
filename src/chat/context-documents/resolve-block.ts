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
    if (path && !await add(path)) throw new Error(`Required context document is missing, unreadable or empty: ${path}. Update Context documents or restore the file before retrying.`);
  }
  const parts: string[] = [];
  const requiredPaths = new Set(documents.customPaths.map(value => value.trim().replace(/\\/g, '/').toLowerCase()));
  let used = 0;
  for (const [index, { path, body }] of sections.entries()) {
    const chunk = `### ${path}\n\n${body}`;
    const remaining = documents.maxTotalChars - used;
    if (chunk.length > remaining && sections.slice(index).some(row => requiredPaths.has(row.path.toLowerCase()))) {
      throw new Error('Required context documents exceed the configured character budget. Increase the Context documents budget or remove a custom path before retrying.');
    }
    if (remaining <= 0) {
      parts.push('[… truncated — context document budget exceeded]');
      break;
    }
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
