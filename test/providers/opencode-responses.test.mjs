/**
 * OpenCode Go Responses routing (MIN-855).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isOpenCodeGoBaseUrl,
  modelLooksOpenAiResponses,
  shouldUseOpenAiResponses,
} from '../../src/lib/openai-responses-route.mjs';
import { resolveGenerationApi, resolveModelApi } from '../../src/lib/resolve-model-api.mjs';
import { resolveCompatibleCompletionUrl } from '../../server/generations/openai-responses/url.js';

describe('isOpenCodeGoBaseUrl', () => {
  test('matches Go origins and rejects Zen', () => {
    assert.equal(isOpenCodeGoBaseUrl('https://opencode.ai/zen/go'), true);
    assert.equal(isOpenCodeGoBaseUrl('https://opencode.ai/zen/go/v1'), true);
    assert.equal(isOpenCodeGoBaseUrl('https://opencode.ai/zen/go/'), true);
    assert.equal(isOpenCodeGoBaseUrl('https://opencode.ai/zen'), false);
    assert.equal(isOpenCodeGoBaseUrl('https://opencode.ai/zen/v1'), false);
    assert.equal(isOpenCodeGoBaseUrl('https://api.openai.com'), false);
  });
});

describe('modelLooksOpenAiResponses', () => {
  test('matches Muse Spark 1.2/1.3 contributor variants', () => {
    assert.equal(modelLooksOpenAiResponses('muse-spark-1.3-contributor'), true);
    assert.equal(modelLooksOpenAiResponses('muse-spark-1.2-contributor'), true);
    assert.equal(modelLooksOpenAiResponses('muse-spark-1.3-contributor-free'), true);
    assert.equal(modelLooksOpenAiResponses('opencode-go/muse-spark-1.3-contributor'), true);
    assert.equal(modelLooksOpenAiResponses('muse-spark-1-3-contributor'), true);
  });

  test('matches GPT 5.6 Luna and Grok 4.6', () => {
    assert.equal(modelLooksOpenAiResponses('gpt-5.6-luna'), true);
    assert.equal(modelLooksOpenAiResponses('gpt-6-luna'), true);
    assert.equal(modelLooksOpenAiResponses('grok-4.6'), true);
  });

  test('rejects chat/completions Go models', () => {
    assert.equal(modelLooksOpenAiResponses('kimi-k3'), false);
    assert.equal(modelLooksOpenAiResponses('glm-5.3'), false);
    assert.equal(modelLooksOpenAiResponses('gpt-4o'), false);
  });
});

describe('shouldUseOpenAiResponses', () => {
  test('requires both Go URL and a Responses model id', () => {
    assert.equal(
      shouldUseOpenAiResponses('https://opencode.ai/zen/go', 'muse-spark-1.3-contributor'),
      true,
    );
    assert.equal(
      shouldUseOpenAiResponses('https://opencode.ai/zen', 'muse-spark-1.3-contributor'),
      false,
    );
    assert.equal(shouldUseOpenAiResponses('https://opencode.ai/zen/go', 'kimi-k3'), false);
  });
});

describe('resolveGenerationApi', () => {
  const go = {
    apiKind: 'openai-v1',
    autoApi: true,
    baseUrl: 'https://opencode.ai/zen/go',
  };
  const zen = {
    apiKind: 'openai-v1',
    autoApi: true,
    baseUrl: 'https://opencode.ai/zen',
  };

  test('catalog resolveModelApi stays openai-v1 for Muse Spark', () => {
    assert.equal(resolveModelApi(go, 'muse-spark-1.3-contributor', null), 'openai-v1');
  });

  test('pump resolveGenerationApi routes Go Muse Spark to openai-responses', () => {
    assert.equal(
      resolveGenerationApi(go, 'muse-spark-1.3-contributor', null),
      'openai-responses',
    );
    assert.equal(resolveGenerationApi(go, 'gpt-5.6-luna', null), 'openai-responses');
    assert.equal(resolveGenerationApi(go, 'gpt-6-luna', null), 'openai-responses');
    assert.equal(resolveGenerationApi(go, 'grok-4.6', null), 'openai-responses');
  });

  test('does not reroute Zen Muse-like ids', () => {
    assert.equal(
      resolveGenerationApi(zen, 'muse-spark-1.3-contributor', null),
      'openai-v1',
    );
  });

  test('leaves chat/completions Go models on openai-v1', () => {
    assert.equal(resolveGenerationApi(go, 'kimi-k3', null), 'openai-v1');
  });
});

describe('resolveCompatibleCompletionUrl', () => {
  test('uses /v1/responses for Go Muse Spark', () => {
    assert.equal(
      resolveCompatibleCompletionUrl(
        'https://opencode.ai/zen/go',
        '/v1/chat/completions',
        'muse-spark-1.2-contributor',
      ),
      'https://opencode.ai/zen/go/v1/responses',
    );
  });

  test('keeps chat/completions for Go Kimi', () => {
    assert.equal(
      resolveCompatibleCompletionUrl(
        'https://opencode.ai/zen/go',
        '/v1/chat/completions',
        'kimi-k3',
      ),
      'https://opencode.ai/zen/go/v1/chat/completions',
    );
  });
});
