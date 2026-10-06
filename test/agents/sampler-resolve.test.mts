import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { resolveSamplerPreset } from '../../src/agents/resolve-sampler.ts';
import {
  mergeUserWorkAgentOverride,
  resetWorkAgentRegistry,
  setUserWorkAgentOverrides,
} from '../../src/agents/work-agent-registry.ts';
import {
  mergeSubAgentConfig,
  resetSubAgentConfigCache,
} from '../../src/agents/sub-agent-config.ts';
import {
  applySamplerToBody,
  clampSamplerPreset,
  mergeSamplerLayers,
  samplerToCompletionFields,
} from '../../src/agents/sampler-types.ts';
import DEFAULTS from '../../src/agents/defaults/sub-agents.json';

describe('sampler preset merge', () => {
  beforeEach(() => {
    resetWorkAgentRegistry();
    setUserWorkAgentOverrides({});
    resetSubAgentConfigCache();
  });

  test('work agent merges global, role default, and user partial override', () => {
    mergeUserWorkAgentOverride('builder', { sampler: { temperature: 0.1 } });
    const resolved = resolveSamplerPreset({
      kind: 'work-agent',
      agentKey: 'builder',
      global: { maxTokens: 8192, preset: { temperature: 0.7 } },
    });
    assert.equal(resolved.preset.temperature, 0.1);
    assert.equal(resolved.preset.topP, 0.95);
    assert.equal(resolved.maxTokens, 8192);
  });

  test('passthrough work agent uses global drawer only', () => {
    const resolved = resolveSamplerPreset({
      kind: 'work-agent',
      agentKey: 'default',
      global: { maxTokens: 4096, preset: { temperature: 0.7 } },
    });
    assert.equal(resolved.preset.temperature, 0.7);
    assert.equal(resolved.preset.topP, undefined);
  });

  test('sub-agent uses type sampler not drawer temperature', () => {
    const merged = mergeSubAgentConfig(DEFAULTS as never, null);
    const shell = merged.types.shell;
    const resolved = resolveSamplerPreset({
      kind: 'sub-agent',
      agentKey: 'shell',
      global: { maxTokens: 9999, preset: { temperature: 0.99 } },
      subAgentType: shell,
    });
    assert.equal(resolved.preset.temperature, 0.7);
    // Type omits maxTokens — inherit Settings global, not the old 2048 cap.
    assert.equal(resolved.maxTokens, 9999);
  });

  test('sub-agent without type maxTokens uses global Settings max not 2048', () => {
    const merged = mergeSubAgentConfig(DEFAULTS as never, null);
    const shell = merged.types.shell;
    const resolved = resolveSamplerPreset({
      kind: 'sub-agent',
      agentKey: 'shell',
      global: { maxTokens: 131072, preset: { temperature: 0.99 } },
      subAgentType: shell,
    });
    assert.equal(resolved.maxTokens, 131072);
    assert.equal(resolved.preset.temperature, 0.7);
  });

  test('sub-agent type maxTokens wins over global Settings max', () => {
    const merged = mergeSubAgentConfig(DEFAULTS as never, null);
    const shell = merged.types.shell;
    const resolved = resolveSamplerPreset({
      kind: 'sub-agent',
      agentKey: 'shell',
      global: { maxTokens: 131072, preset: {} },
      subAgentType: {
        ...shell,
        sampler: { ...shell.sampler, maxTokens: 512 },
      },
    });
    assert.equal(resolved.maxTokens, 512);
  });

  test('clampSamplerPreset strips invalid values', () => {
    const clamped = clampSamplerPreset({
      temperature: 9,
      topP: -1,
      topK: 0,
      minP: 0,
      repetitionPenalty: 0.5,
    });
    assert.equal(clamped.temperature, 2);
    assert.equal(clamped.topP, 0);
    assert.equal(clamped.topK, undefined);
    assert.equal(clamped.repetitionPenalty, undefined);
  });

  test('samplerToCompletionFields omits unset extended params', () => {
    const fields = samplerToCompletionFields({ temperature: 0.3 }, 2048);
    assert.equal(fields.temperature, 0.3);
    assert.equal(fields.max_tokens, 2048);
    assert.equal(fields.top_p, undefined);
  });

  test('samplerToCompletionFields sends explicit neutral values to override runtime defaults', () => {
    const fields = samplerToCompletionFields(
      {
        temperature: 1,
        topP: 0.95,
        topK: 20,
        minP: 0,
        repetitionPenalty: 1,
        presencePenalty: 0,
      },
      32768,
    );
    assert.equal(fields.min_p, 0);
    assert.equal(fields.repetition_penalty, 1);
    assert.equal(fields.presence_penalty, 0);
  });

  test('applySamplerToBody spreads mapped keys', () => {
    const body = applySamplerToBody(
      { model: 'test-model', messages: [] },
      { temperature: 0.25, topP: 0.9, topK: 40 },
      1024,
    );
    assert.equal(body.temperature, 0.25);
    assert.equal(body.top_p, 0.9);
    assert.equal(body.top_k, 40);
    assert.equal(body.max_tokens, 1024);
  });

  test('applySamplerToBody requests include_usage on streamed bodies', () => {
    const body = applySamplerToBody(
      { model: 'test-model', messages: [], stream: true },
      { temperature: 0.7 },
      2048,
    );
    assert.equal(body.stream_options?.include_usage, true);
  });

  test('mergeSamplerLayers is field-level', () => {
    const merged = mergeSamplerLayers(
      { temperature: 0.5, topP: 0.8 },
      { temperature: 0.2 },
    );
    assert.equal(merged.temperature, 0.2);
    assert.equal(merged.topP, 0.8);
  });

  test('presence penalty maps to presence_penalty and clamps to [0,2]', () => {
    const fields = samplerToCompletionFields(
      { temperature: 0.7, presencePenalty: 1.5 },
      2048,
    );
    assert.equal(fields.presence_penalty, 1.5);
    assert.equal(clampSamplerPreset({ presencePenalty: 3 }).presencePenalty, 2);
    assert.equal(
      clampSamplerPreset({ presencePenalty: -1 }).presencePenalty,
      undefined,
    );
  });

  test('mergeSamplerLayers overrides presence penalty when defined', () => {
    const merged = mergeSamplerLayers(
      { presencePenalty: 0 },
      { presencePenalty: 1.5 },
    );
    assert.equal(merged.presencePenalty, 1.5);
  });

  test('clampSamplerPreset and samplerToCompletionFields keep stop sequences', () => {
    const clamped = clampSamplerPreset({
      stop: ['  END  ', '', 'USER:'],
    });
    assert.deepEqual(clamped.stop, ['END', 'USER:']);
    const fields = samplerToCompletionFields(clamped, 2048);
    assert.deepEqual(fields.stop, ['END', 'USER:']);
    const fromString = clampSamplerPreset({ stop: 'STOP' });
    assert.deepEqual(fromString.stop, ['STOP']);
    const capped = clampSamplerPreset({
      stop: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
    });
    assert.deepEqual(capped.stop, ['1', '2', '3', '4', '5', '6', '7', '8']);
  });
});
