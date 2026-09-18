/**
 * Mode-handoff prompt fragment and composer integration.
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

async function loadHandoffPromptMap() {
  const toolDir = path.join(REPO_ROOT, 'src/chat/prompts/tool-usage');
  const baseDir = path.join(REPO_ROOT, 'src/chat/prompts/base');
  const map = await loadBuiltinModePromptMap();
  map['./tool-usage/mode-handoff.full.md'] = await fs.readFile(
    path.join(toolDir, 'mode-handoff.md'),
    'utf8',
  );
  map['./tool-usage/mode-handoff.lite.md'] = await fs.readFile(
    path.join(toolDir, 'mode-handoff.lite.md'),
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
  map['./modes/plan.full.md'] = map['./modes/plan.full.md'] ?? (await fs.readFile(
    path.join(REPO_ROOT, 'src/chat/prompts/modes/plan.full.md'),
    'utf8',
  ));
  return map;
}

describe('mode-handoff prompts', () => {
  beforeEach(() => {
    resetPromptRegistry();
  });

  test('mode-handoff fragment loads with ask_question and host tools', async () => {
    registerPromptFilesFromRaw(await loadHandoffPromptMap());
    const loaded = loadPromptById('tool-usage', 'mode-handoff', 'full');
    assert.ok(loaded?.body);
    assert.match(loaded.body, /ask_question/);
    assert.match(loaded.body, /propose_mode_switch/);
    assert.match(loaded.body, /set_chat_mode/);
    assert.doesNotMatch(loaded.body, /modeId:/);
    assert.doesNotMatch(loaded.body, /reef-widget/);
  });

  test('composeSystemPrompt appends handoff for plan mode', async () => {
    registerPromptFilesFromRaw(await loadHandoffPromptMap());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/proj',
      modeId: 'plan',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['ask_question', 'propose_mode_switch'],
    });
    assert.match(out, /^## Mode handoff \(structured switches\)/m);
    assert.match(out, /set_chat_mode/);
    assert.match(out, /Operating mode: Plan/);
  });

  test('composeSystemPrompt omits handoff when modeId is null', async () => {
    registerPromptFilesFromRaw(await loadHandoffPromptMap());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/proj',
      modeId: null,
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['ask_question'],
    });
    // The base tool-usage prompt names the fragment in prose; only its heading proves it was appended.
    assert.doesNotMatch(out, /^## Mode handoff \(structured switches\)/m);
  });

  test('plan.full references propose_mode_switch handoff', async () => {
    const planBody = await fs.readFile(
      path.join(REPO_ROOT, 'src/chat/prompts/modes/plan.full.md'),
      'utf8',
    );
    assert.match(planBody, /propose_mode_switch/);
    assert.match(planBody, /set_chat_mode/);
  });
});