/**
 * Memory save prompt fragment — gated on brain write tools in compose context.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeSystemPrompt } from '../../src/chat/prompts/prompt-composer.ts';
import {
  registerPromptFilesFromRaw,
  resetPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PROMPTS_ROOT = path.join(REPO_ROOT, 'src/chat/prompts');

async function loadShippedPromptMap() {
  const out = {};
  async function walk(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '_example') continue;
        await walk(full, rel);
      } else if (entry.name.endsWith('.md')) {
        out[`./${rel.replace(/\\/g, '/')}`] = await fs.readFile(full, 'utf8');
      }
    }
  }
  await walk(PROMPTS_ROOT);
  return out;
}

describe('memory-save prompt fragment', () => {
  beforeEach(() => {
    resetPromptRegistry();
  });

  test('includes Saving new knowledge when save_memory is enabled', async () => {
    registerPromptFilesFromRaw(await loadShippedPromptMap());
    const out = composeSystemPrompt({
        cwd: '/proj',
      modeId: 'build',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: 'Prior note about auth.',
      memoryEnabled: true,
      enabledToolIds: ['save_memory', 'read_file'],
    });
    assert.match(out, /Saving new knowledge/);
    assert.match(out, /Prior note about auth/);
  });

  test('omits save block when save_memory is disabled but keeps retrieved notes', async () => {
    registerPromptFilesFromRaw(await loadShippedPromptMap());
    const out = composeSystemPrompt({
        cwd: '/proj',
      modeId: 'build',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: 'Injected wiki note.',
      memoryEnabled: true,
      enabledToolIds: ['read_file', 'brain_search'],
    });
    assert.doesNotMatch(out, /Saving new knowledge/);
    assert.match(out, /Injected wiki note/);
  });
});
