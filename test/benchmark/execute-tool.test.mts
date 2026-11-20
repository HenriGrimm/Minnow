import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CAPABILITY_SIDE_EFFECT_TOOL_IDS,
  createCapabilityExecuteToolFn,
  isCapabilitySideEffectTool,
} from '../../src/benchmark/capabilities/execute-tool.ts';
import { isBenchmarkStubbedTool } from '../../src/benchmark/execute-tool-sandbox.ts';

describe('capability matrix execute-tool', () => {
  test('side-effect catalog includes emit-only probe tools', () => {
    assert.equal(isCapabilitySideEffectTool('web_search'), true);
    assert.equal(isCapabilitySideEffectTool('memory_save'), true);
    assert.equal(isCapabilitySideEffectTool('git_commit'), true);
    assert.equal(isCapabilitySideEffectTool('get_datetime'), false);
    assert.ok(CAPABILITY_SIDE_EFFECT_TOOL_IDS.size >= 20);
  });

  test('allowSideEffects false stubs web_search without benchmark sandbox flag', async () => {
    const execute = createCapabilityExecuteToolFn(false);
    const out = await execute('web_search', { query: 'TypeScript' });
    const parsed = JSON.parse(out.content) as {
      capabilityEmitOnly?: boolean;
      stubbed?: string;
    };
    assert.equal(parsed.capabilityEmitOnly, true);
    assert.equal(parsed.stubbed, 'web_search');
  });

  test('allowSideEffects false stubs spawn_sub_agent', async () => {
    const execute = createCapabilityExecuteToolFn(false);
    const out = await execute('spawn_sub_agent', { type: 'explore', prompt: 'x' });
    const parsed = JSON.parse(out.content) as { stubbed?: string };
    assert.equal(parsed.stubbed, 'spawn_sub_agent');
    assert.equal(isBenchmarkStubbedTool('spawn_sub_agent'), true);
  });

  test('allowSideEffects true uses benchmark sandbox for spawn_sub_agent', async () => {
    const execute = createCapabilityExecuteToolFn(true);
    const out = await execute('spawn_sub_agent', { type: 'explore', prompt: 'x' });
    const parsed = JSON.parse(out.content) as { benchmark?: boolean; stubbed?: string };
    assert.equal(parsed.benchmark, true);
    assert.equal(parsed.stubbed, 'spawn_sub_agent');
    assert.equal('capabilityEmitOnly' in parsed, false);
  });

  test('ask_question is stubbed when side effects disallowed', async () => {
    const execute = createCapabilityExecuteToolFn(false);
    const out = await execute('ask_question', {
      questions: [
        {
          id: 'cap-q',
          prompt: 'Pick',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
      ],
    });
    const parsed = JSON.parse(out.content) as { status: string };
    assert.equal(parsed.status, 'cancelled');
  });
});
