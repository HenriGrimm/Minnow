/**
 * Prompt composer: order, separators, disabled parts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { beforeEach, describe, test } from 'node:test';
import {
  composeSystemPrompt,
  PART_ORDER,
} from '../../src/chat/prompts/prompt-composer.ts';
import {
  registerPromptFilesFromRaw,
  resetPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';
import { fixturePath } from './test-helpers.mjs';

async function loadFixtureMap() {
  const names = [
    'base-default.full.md',
    'base-default.lite.md',
    'tool-usage-default.full.md',
    'tool-usage-default.lite.md',
    'info-general-assistant.full.md',
  ];
  const map = {};
  for (const name of names) {
    const folder =
      name.startsWith('base') ? 'base' : name.startsWith('tool') ? 'tool-usage' : 'info';
    const key = `./${folder}/${name}`;
    map[key] = await fs.readFile(fixturePath(name), 'utf8');
  }
  return map;
}

describe('prompt-composer', () => {
  beforeEach(() => {
    resetPromptRegistry();
  });

  test('CLI composition keeps stable instructions while current-turn info changes', async () => {
    registerPromptFilesFromRaw(await loadFixtureMap());
    const context = { cwd: '/one', modeId: 'build', expertId: null, workAgentId: null,
      skillBody: null, memoryBlock: 'Memory one', enabledToolIds: ['get_datetime'], infoPresetId: null };
    const first = [], second = [];
    const a = composeSystemPrompt(context, { turnContext: first });
    const b = composeSystemPrompt({ ...context, memoryBlock: 'Memory two' }, { turnContext: second });
    assert.equal(a, b); assert.equal(a.includes('Memory one'), false);
    assert.ok(first.join('').includes('Memory one'));
    assert.notDeepEqual(first, second);
    const notice = 'Optional enrichment unavailable: memory (deadline).';
    const feedback = [];
    assert.equal(composeSystemPrompt({ ...context, enrichmentNotice: notice }, { turnContext: feedback }), a);
    assert.ok(feedback.includes(notice), 'omissions are per-turn CLI feedback, not stable instructions');
    assert.ok(composeSystemPrompt({ ...context, enrichmentNotice: notice }).includes(notice));
  });

  test('PART_ORDER matches spec', () => {
    assert.deepEqual(PART_ORDER, [
      'base',
      'mode',
      'expert',
      'work-agent',
      'tool-usage',
      'info',
      'skill',
      'memory',
      'code-map',
      'context-documents',
    ]);
  });

  test('composition order and separators', async () => {
    registerPromptFilesFromRaw(await loadFixtureMap());
    const out = composeSystemPrompt({
      cwd: '/test',
      modeId: 'build',
      expertId: null,
      workAgentId: null,
      skillBody: 'SKILL_BODY',
      memoryBlock: null,
      enabledToolIds: ['get_datetime'],
      infoPresetId: null,
    });
    const parts = out.split('\n\n---\n\n');
    assert.ok(parts[0].includes('BASE_FULL_BODY'));
    const tools = parts.findIndex((p) => p.includes('TOOLS_FULL'));
    const skill = parts.findIndex((p) => p.includes('SKILL_BODY'));
    assert.ok(tools > 0 && skill > tools);
  });

  test('info presets are retired with General mode', async () => {
    registerPromptFilesFromRaw(await loadFixtureMap());
    for (const modeId of ['general', 'build']) {
      const out = composeSystemPrompt({
        cwd: '/test', modeId, expertId: null, workAgentId: null, skillBody: null,
        memoryBlock: null, enabledToolIds: ['get_datetime'], infoPresetId: 'general-assistant',
      });
      assert.ok(!out.includes('INFO_GENERAL_BODY'), modeId);
    }
  });

  test('ignores legacy prompt size and files', async () => {
    registerPromptFilesFromRaw(await loadFixtureMap());
    registerPromptFilesFromRaw({ './base/lite.md': await fs.readFile(fixturePath('base-default.lite.md'), 'utf8') }, 'user');
    const out = composeSystemPrompt({
      profile: 'lite',
      cwd: '/test',
      modeId: null,
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['a', 'b'],
      infoPresetId: 'general-assistant',
    });
    assert.ok(out.includes('BASE_FULL_BODY'));
    assert.ok(out.includes('TOOLS_FULL'));
    assert.doesNotMatch(out, /BASE_LITE_BODY|TOOLS_LITE/);
    assert.ok(!out.includes('INFO_GENERAL_BODY'));
  });
});
