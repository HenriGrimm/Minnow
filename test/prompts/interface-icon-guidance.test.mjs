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

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

async function loadPromptMap() {
  const promptsRoot = path.join(REPO_ROOT, 'src', 'chat', 'prompts');
  const files = [
    'base/default.full.md',
    'base/default.lite.md',
    'info/interface-icons.full.md',
    'info/interface-icons.lite.md',
  ];
  const out = {};
  for (const relativePath of files) {
    out[`./${relativePath}`] = await fs.readFile(
      path.join(promptsRoot, relativePath),
      'utf8',
    );
  }
  return out;
}

function compose(overrides = {}) {
  return composeSystemPrompt({
    profile: 'full',
    cwd: '/test',
    modeId: null,
    expertId: null,
    workAgentId: null,
    skillBody: null,
    memoryBlock: null,
    codeMapBlock: null,
    contextDocumentsBlock: null,
    enabledToolIds: [],
    infoPresetId: null,
    ...overrides,
  });
}

describe('interface icon prompt guidance', () => {
  beforeEach(async () => {
    resetPromptRegistry();
    registerPromptFilesFromRaw(await loadPromptMap());
  });

  test('defaults to Flaticon guidance with an explicit emoji icon ban', () => {
    const prompt = compose();
    assert.match(prompt, /Never use emojis as icons/);
    assert.match(prompt, /@flaticon\/flaticon-uicons/);
  });

  test('can be disabled through compose context', () => {
    const prompt = compose({ flaticonIconGuidanceEnabled: false });
    assert.doesNotMatch(prompt, /Never use emojis as icons/);
    assert.doesNotMatch(prompt, /@flaticon\/flaticon-uicons/);
  });

  test('uses the compact rule in the lite profile', () => {
    const prompt = compose({ profile: 'lite' });
    assert.match(prompt, /Never use emojis as icons/);
    assert.match(prompt, /@flaticon\/flaticon-uicons/);
  });

  test('stays enabled for custom prompt profiles', () => {
    const prompt = compose({ profile: 'custom' });
    assert.match(prompt, /Never use emojis as icons/);
    assert.match(prompt, /@flaticon\/flaticon-uicons/);
  });
});
