/**
 * Sub-agent delegation fragment: one agent, no types, gated on the tool only.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { composeSystemPrompt } from '../../src/chat/prompts/prompt-composer.ts';
import {
  loadPromptById,
  registerPromptFilesFromRaw,
  resetPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';
import { baseComposeContext, loadAllBuiltinPrompts } from './test-helpers.mjs';

describe('sub-agent-delegation prompts', () => {
  beforeEach(async () => {
    resetPromptRegistry();
    registerPromptFilesFromRaw(await loadAllBuiltinPrompts());
  });

  test('fragment describes one agent with no types and background waits', () => {
    const body = loadPromptById('tool-usage', 'sub-agent-delegation', 'full')?.body ?? '';
    assert.match(body, /same agent/);
    assert.match(body, /no agent types/i);
    assert.match(body, /wait: false/);
    assert.doesNotMatch(body, /generalPurpose|researcher|`explore`/);
  });

  test('appended whenever spawn_sub_agent is available, in any profile', () => {
    for (const profile of ['full', 'lite']) {
      const prompt = composeSystemPrompt(baseComposeContext({ profile, enabledToolIds: ['read_file', 'spawn_sub_agent'] }));
      assert.match(prompt, /## Sub-agents/, profile);
    }
  });

  test('omitted when spawn_sub_agent is unavailable', () => {
    const prompt = composeSystemPrompt(baseComposeContext());
    assert.doesNotMatch(prompt, /## Sub-agents/);
  });

  test('chat coordination guidance is gated on the chat tools only', () => {
    const without = composeSystemPrompt(baseComposeContext());
    assert.doesNotMatch(without, /## Chat coordination/);
    const withTools = composeSystemPrompt(baseComposeContext({ enabledToolIds: ['read_file', 'chat_send'] }));
    assert.match(withTools, /## Chat coordination/);
    assert.doesNotMatch(withTools, /stronger mode/);
  });
});
