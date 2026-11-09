/**
 * One agent everywhere: the base prompt carries the permission level and any
 * turn clamp, modes add no prompt part (except Orchestrate), work agents are
 * never auto-selected, and the local-model appendix follows its setting.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  composeSystemPrompt,
  isLocalModelGuidanceEnabled,
} from '../../src/chat/prompts/prompt-composer.ts';
import {
  registerPromptFilesFromRaw,
  resetPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';
import { baseComposeContext, loadAllBuiltinPrompts } from './test-helpers.mjs';

const LOCAL_HEADING = /## Working with tools/;

describe('single-agent prompt', () => {
  beforeEach(async () => {
    resetPromptRegistry();
    registerPromptFilesFromRaw(await loadAllBuiltinPrompts());
  });

  test('base prompt names the permission level', () => {
    assert.match(composeSystemPrompt(baseComposeContext()), /Permission level: Auto\./);
    assert.match(composeSystemPrompt(baseComposeContext({ permissionLevel: 'manual' })), /Permission level: Manual\./);
    assert.match(composeSystemPrompt(baseComposeContext({ permissionLevel: 'full' })), /Permission level: Full access\./);
  });

  test('a turn clamp adds its restriction line', () => {
    assert.match(composeSystemPrompt(baseComposeContext({ turnClamp: 'read-only' })), /read-only \(\/ask\)/);
    assert.match(composeSystemPrompt(baseComposeContext({ turnClamp: 'plans' })), /documentation\/plans\//);
    assert.doesNotMatch(composeSystemPrompt(baseComposeContext()), /\/ask\)|planning only/);
  });

  test('legacy modes compose the same prompt; only Orchestrate adds a mode part', () => {
    const build = composeSystemPrompt(baseComposeContext({ modeId: 'build' }));
    for (const modeId of ['plan', 'debug', 'general']) {
      assert.equal(composeSystemPrompt(baseComposeContext({ modeId })), build, modeId);
    }
    const orchestrate = composeSystemPrompt(baseComposeContext({ modeId: 'orchestrate' }));
    assert.ok(orchestrate.length > build.length, 'orchestrate keeps its board prompt');
  });

  test('lite profile uses the one base prompt and tool usage', () => {
    const base = composeSystemPrompt(baseComposeContext({ enabledToolIds: ['read_file'], flaticonIconGuidanceEnabled: false }));
    const lite = composeSystemPrompt(baseComposeContext({ profile: 'lite', enabledToolIds: ['read_file'], flaticonIconGuidanceEnabled: false }));
    assert.match(lite, /You are Minnow/);
    assert.match(lite, /## Tools/);
    assert.equal(lite, base);
  });

  test('no mode-handoff, browser-allowlist or duplicated verification fragments', () => {
    const prompt = composeSystemPrompt(baseComposeContext({
      enabledToolIds: ['read_file', 'execute_command', 'browser_navigate', 'ask_question', 'spawn_sub_agent'],
    }));
    assert.doesNotMatch(prompt, /propose_mode_switch|set_chat_mode|request_browser_origin_access|allowlist/i);
  });

  test('base + tool usage stays lean', () => {
    const prompt = composeSystemPrompt(baseComposeContext({ flaticonIconGuidanceEnabled: false }));
    assert.ok(prompt.length < 6000, `prompt is ${prompt.length} chars`);
  });

  test('local-model appendix: auto follows the provider, on/off override it', () => {
    assert.equal(isLocalModelGuidanceEnabled(baseComposeContext({ providerIsLocal: true })), true);
    assert.equal(isLocalModelGuidanceEnabled(baseComposeContext({ providerIsLocal: false })), false);
    assert.equal(isLocalModelGuidanceEnabled(baseComposeContext({ localModelGuidance: 'on', providerIsLocal: false })), true);
    assert.equal(isLocalModelGuidanceEnabled(baseComposeContext({ localModelGuidance: 'off', providerIsLocal: true })), false);
    assert.match(composeSystemPrompt(baseComposeContext({ providerIsLocal: true })), LOCAL_HEADING);
    assert.doesNotMatch(composeSystemPrompt(baseComposeContext({ providerIsLocal: false })), LOCAL_HEADING);
    assert.doesNotMatch(
      composeSystemPrompt(baseComposeContext({ providerIsLocal: true, localModelGuidance: 'off' })),
      LOCAL_HEADING,
    );
  });
});
