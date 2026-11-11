/**
 * Helpers for prompt unit tests (tsx + node:test).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(__dirname, 'fixtures');

export function fixturePath(name) {
  return path.join(FIXTURES_DIR, name);
}

const PROMPTS_ROOT = path.resolve(__dirname, '../../src/chat/prompts');

/** Every shipped prompt markdown, keyed like the Vite glob (`./base/default.full.md`). */
export async function loadAllBuiltinPrompts() {
  const fs = await import('node:fs/promises');
  const out = {};
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md')) {
        out[`./${path.relative(PROMPTS_ROOT, full).split(path.sep).join('/')}`] = await fs.readFile(full, 'utf8');
      }
    }
  }
  await walk(PROMPTS_ROOT);
  return out;
}

/** Minimal compose context for the single agent. */
export function baseComposeContext(overrides = {}) {
  return {
    cwd: '/repo',
    modeId: 'build',
    expertId: null,
    workAgentId: null,
    skillBody: null,
    memoryBlock: null,
    codeMapBlock: null,
    contextDocumentsBlock: null,
    enabledToolIds: ['read_file', 'execute_command'],
    infoPresetId: null,
    ...overrides,
  };
}
