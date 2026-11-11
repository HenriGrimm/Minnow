import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { composeSystemPrompt, shouldSuppressModePart, stripPromptHtmlComments } from '../../src/chat/prompts/prompt-composer.ts';
import { registerPromptFilesFromRaw, resetPromptRegistry } from '../../src/chat/prompts/prompt-loader.ts';
import type { ComposeContext } from '../../src/chat/prompts/types.ts';

const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
const planSkill = read('skills/plan/SKILL.md').replace(/^---[\s\S]*?\n---\s*/, '');

beforeEach(() => {
  resetPromptRegistry();
  const files = ['base/default.full.md', 'tool-usage/default.full.md', 'modes/orchestrate.full.md'];
  registerPromptFilesFromRaw(Object.fromEntries(files.map(path => [`./${path}`, read(`chat/prompts/${path}`)])));
});

function compose(overrides: Partial<ComposeContext> = {}) {
  return composeSystemPrompt({ cwd: '/workspace', modeId: 'build', expertId: null,
    workAgentId: null, skillBody: null, memoryBlock: null, enabledToolIds: ['ask_question'], infoPresetId: null,
    ...overrides });
}

test('stripPromptHtmlComments removes prompt markers', () => {
  assert.equal(stripPromptHtmlComments('a<!-- MINNOW_MODE_MARKER: plan -->b'), 'ab');
});

test('ordinary mode labels do not select a separate agent prompt', () => {
  for (const modeId of ['build', 'plan', 'general', 'debug']) {
    assert.equal(shouldSuppressModePart({ modeId } as ComposeContext), true);
    assert.doesNotMatch(compose({ modeId }), /Operating mode:/);
  }
});

test('the shared prompt includes planning format choice when the /plan skill runs', () => {
  const out = compose({ skillBody: planSkill, turnClamp: 'plans' });
  assert.match(out, /How would you like to build this\?/);
  assert.match(out, /planType: build/);
  assert.match(out, /Preserve its type unless the user explicitly requests conversion/);
  assert.match(out, /## Wave Breakdown/);
  assert.match(out, /## Implementation steps/);
  assert.match(out, /planning only/);
});

test('Orchestrate retains its board instructions and strips prompt markers', () => {
  const out = compose({ modeId: 'orchestrate' });
  assert.match(out, /Operating mode: Orchestrate/);
  assert.doesNotMatch(out, /MINNOW_MODE_MARKER/);
});
