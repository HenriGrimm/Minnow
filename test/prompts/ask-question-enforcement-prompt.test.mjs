/**
 * ask_question guidance: short, tool-gated, no mode or browser-origin rows.
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

describe('ask-question-enforcement prompts', () => {
  beforeEach(async () => {
    resetPromptRegistry();
    registerPromptFilesFromRaw(await loadAllBuiltinPrompts());
  });

  test('fragment requires ask_question for choices and drops legacy rows', () => {
    const body = loadPromptById('tool-usage', 'ask-question-enforcement', 'full')?.body ?? '';
    assert.match(body, /`ask_question`/);
    assert.match(body, /numbered list/);
    assert.doesNotMatch(body, /propose_mode_switch|request_browser_origin_access/);
  });

  test('appended when ask_question is enabled', () => {
    const prompt = composeSystemPrompt(baseComposeContext({ enabledToolIds: ['read_file', 'ask_question'] }));
    assert.match(prompt, /## Asking the user/);
  });

  test('omitted when ask_question is disabled', () => {
    const prompt = composeSystemPrompt(baseComposeContext());
    assert.doesNotMatch(prompt, /## Asking the user/);
  });
});
