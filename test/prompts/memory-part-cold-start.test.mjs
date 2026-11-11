/**
 * Memory part cold-start gating — save guidance must inject even when the wiki
 * is empty, as long as memory is enabled and brain write tools are available.
 *
 * Regression: the memory part (the only prompt section teaching save_memory /
 * brain_write_page usage) was gated on a non-empty retrieval block, so a fresh
 * install never told the agent how to save → nothing was ever written → the
 * section never appeared.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, test } from 'node:test';
import { composeSystemPrompt } from '../../src/chat/prompts/prompt-composer.ts';
import {
  registerPromptFilesFromRaw,
  resetPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';
import { fixturePath } from './test-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.join(here, '..', '..', 'src', 'chat', 'prompts');

async function registerFixtures() {
  const map = {
    './base/base-default.full.md': await fs.readFile(
      fixturePath('base-default.full.md'),
      'utf8',
    ),
    './tool-usage/tool-usage-default.full.md': await fs.readFile(
      fixturePath('tool-usage-default.full.md'),
      'utf8',
    ),
    // Real shipped memory templates (kind: info, id: memory).
    './memory/memory.full.md': await fs.readFile(
      path.join(promptsDir, 'memory', 'full.md'),
      'utf8',
    ),
  };
  registerPromptFilesFromRaw(map);
}

function baseCtx(overrides = {}) {
  return {
    cwd: '/test',
    modeId: 'build',
    expertId: null,
    workAgentId: null,
    skillBody: null,
    memoryBlock: null,
    memoryEnabled: true,
    enabledToolIds: ['get_datetime', 'save_memory', 'brain_write_page'],
    infoPresetId: null,
    ...overrides,
  };
}

describe('memory part cold-start gating', () => {
  beforeEach(() => {
    resetPromptRegistry();
  });

  test('empty wiki + memory on + write tools → save guidance injects', async () => {
    await registerFixtures();
    const out = composeSystemPrompt(baseCtx());
    assert.ok(out.includes('save_memory'), 'expected save_memory guidance');
    assert.ok(out.includes('brain_write_page'), 'expected brain_write_page guidance');
    assert.ok(
      out.includes('no wiki notes matched this message'),
      'expected empty-retrieval placeholder for {{memory}}',
    );
  });

  test('retrieved block still injects and interpolates', async () => {
    await registerFixtures();
    const out = composeSystemPrompt(
      baseCtx({ memoryBlock: 'RETRIEVED_NOTE_XYZ' }),
    );
    assert.ok(out.includes('RETRIEVED_NOTE_XYZ'));
    assert.ok(!out.includes('no wiki notes matched this message'));
  });

  test('memory disabled → no memory section without a block', async () => {
    await registerFixtures();
    const out = composeSystemPrompt(baseCtx({ memoryEnabled: false }));
    assert.ok(!out.includes('save_memory'));
  });

  test('no brain write tools → no memory section without a block', async () => {
    await registerFixtures();
    const out = composeSystemPrompt(
      baseCtx({ enabledToolIds: ['get_datetime'] }),
    );
    assert.ok(!out.includes('save_memory'));
  });

});
