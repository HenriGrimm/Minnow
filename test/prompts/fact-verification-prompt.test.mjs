/**
 * Fact-verification and Context7 prompt fragments and composer integration.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeSystemPrompt } from '../../src/chat/prompts/prompt-composer.ts';
import {
  loadPromptById,
  registerPromptFilesFromRaw,
  resetPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';
import { loadBuiltinModePromptMap } from '../modes/test-helpers.mts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

async function loadFactVerificationPromptMap() {
  const toolDir = path.join(REPO_ROOT, 'src/chat/prompts/tool-usage');
  const baseDir = path.join(REPO_ROOT, 'src/chat/prompts/base');
  const modesDir = path.join(REPO_ROOT, 'src/chat/prompts/modes');
  const map = await loadBuiltinModePromptMap();
  map['./tool-usage/fact-verification.full.md'] = await fs.readFile(
    path.join(toolDir, 'fact-verification.md'),
    'utf8',
  );
  map['./tool-usage/fact-verification.lite.md'] = await fs.readFile(
    path.join(toolDir, 'fact-verification.lite.md'),
    'utf8',
  );
  map['./tool-usage/investigate-before-answer.full.md'] = await fs.readFile(
    path.join(toolDir, 'investigate-before-answer.md'),
    'utf8',
  );
  map['./tool-usage/investigate-before-answer.lite.md'] = await fs.readFile(
    path.join(toolDir, 'investigate-before-answer.lite.md'),
    'utf8',
  );
  map['./tool-usage/sub-agent-delegation.full.md'] = await fs.readFile(
    path.join(toolDir, 'sub-agent-delegation.md'),
    'utf8',
  );
  map['./tool-usage/sub-agent-delegation.lite.md'] = await fs.readFile(
    path.join(toolDir, 'sub-agent-delegation.lite.md'),
    'utf8',
  );
  map['./tool-usage/context7-docs.full.md'] = await fs.readFile(
    path.join(toolDir, 'context7-docs.md'),
    'utf8',
  );
  map['./tool-usage/context7-docs.lite.md'] = await fs.readFile(
    path.join(toolDir, 'context7-docs.lite.md'),
    'utf8',
  );
  map['./tool-usage/default.full.md'] = await fs.readFile(
    path.join(toolDir, 'default.full.md'),
    'utf8',
  );
  map['./base/default.full.md'] = await fs.readFile(
    path.join(baseDir, 'default.full.md'),
    'utf8',
  );
  map['./modes/plan.full.md'] = await fs.readFile(
    path.join(modesDir, 'plan.full.md'),
    'utf8',
  );
  map['./modes/build.full.md'] = await fs.readFile(
    path.join(modesDir, 'build.full.md'),
    'utf8',
  );
  map['./modes/general.full.md'] = map['./modes/general.full.md'] ?? (await fs.readFile(
    path.join(modesDir, 'general.full.md'),
    'utf8',
  ));
  map['./modes/orchestrate.full.md'] = map['./modes/orchestrate.full.md'] ?? (await fs.readFile(
    path.join(modesDir, 'orchestrate.full.md'),
    'utf8',
  ));
  return map;
}

describe('fact-verification prompts', () => {
  beforeEach(() => {
    resetPromptRegistry();
  });

  test('investigate-before-answer fragment teaches investigation ladder', async () => {
    registerPromptFilesFromRaw(await loadFactVerificationPromptMap());
    const loaded = loadPromptById('tool-usage', 'investigate-before-answer', 'full');
    assert.ok(loaded?.body);
    assert.match(loaded.body, /Investigation ladder/i);
    assert.match(loaded.body, /two distinct tool-backed sources/i);
    assert.match(loaded.body, /rag_web_content/);
  });

  test('composeSystemPrompt includes investigate-before-answer for debug mode', async () => {
    registerPromptFilesFromRaw(await loadFactVerificationPromptMap());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/proj',
      modeId: 'debug',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['read_file', 'grep'],
    });
    assert.match(out, /## Investigate before you answer/);
  });

  test('fragment teaches verification ladder and web tools', async () => {
    registerPromptFilesFromRaw(await loadFactVerificationPromptMap());
    const loaded = loadPromptById('tool-usage', 'fact-verification', 'full');
    assert.ok(loaded?.body);
    assert.match(loaded.body, /Verification ladder/i);
    assert.match(loaded.body, /web_search/);
    assert.match(loaded.body, /fetch_web_content/);
    assert.match(loaded.body, /rag_web_content/);
    assert.match(loaded.body, /Context7/);
  });

  test('context7 fragment teaches the current tool workflow', async () => {
    registerPromptFilesFromRaw(await loadFactVerificationPromptMap());
    const loaded = loadPromptById('tool-usage', 'context7-docs', 'full');
    assert.ok(loaded?.body);
    assert.match(loaded.body, /mcp__context7__resolve_library_id/);
    assert.match(loaded.body, /mcp__context7__query_docs/);
  });

  test('composeSystemPrompt includes fact-verification for plan mode with tools', async () => {
    registerPromptFilesFromRaw(await loadFactVerificationPromptMap());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/proj',
      modeId: 'plan',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['read_file', 'grep'],
    });
    assert.match(out, /## Verify before you plan or build/);
    assert.match(out, /Verification ladder/i);
  });

  test('composeSystemPrompt includes fact-verification for build and general modes', async () => {
    registerPromptFilesFromRaw(await loadFactVerificationPromptMap());
    for (const modeId of ['build', 'general']) {
      const out = composeSystemPrompt({
        profile: 'full',
        cwd: '/proj',
        modeId,
        expertId: null,
        workAgentId: null,
        skillBody: null,
        memoryBlock: null,
        enabledToolIds: ['read_file'],
      });
      assert.match(out, /## Verify before you plan or build/, modeId);
    }
  });

  test('composeSystemPrompt omits fact-verification for orchestrate mode', async () => {
    registerPromptFilesFromRaw(await loadFactVerificationPromptMap());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/proj',
      modeId: 'orchestrate',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['read_file', 'grep'],
    });
    assert.doesNotMatch(out, /## Verify before you plan or build/);
  });

  test('composeSystemPrompt omits fact-verification when no tools enabled', async () => {
    registerPromptFilesFromRaw(await loadFactVerificationPromptMap());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/proj',
      modeId: 'plan',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: [],
    });
    assert.doesNotMatch(out, /## Verify before you plan or build/);
  });

  test('composeSystemPrompt includes context7-docs when Context7 tools enabled', async () => {
    registerPromptFilesFromRaw(await loadFactVerificationPromptMap());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/proj',
      modeId: 'plan',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: [
        'read_file',
        'mcp__context7__resolve_library_id',
        'mcp__context7__query_docs',
      ],
    });
    assert.match(out, /## Context7 library docs/);
    assert.match(out, /mcp__context7__resolve_library_id/);
  });

  test('composeSystemPrompt omits context7-docs without Context7 tools', async () => {
    registerPromptFilesFromRaw(await loadFactVerificationPromptMap());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/proj',
      modeId: 'plan',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['read_file', 'web_search'],
    });
    assert.doesNotMatch(out, /## Context7 library docs/);
    assert.doesNotMatch(out, /mcp__context7__resolve_library_id/);
  });
});
