/**
 * Model producer slug, display name, and logo resolution.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  modelProducerLogoSvg,
  producerDisplayName,
  producerSlugFromModelId,
  resolveModelProducer,
} from '../../src/providers/model-producer.ts';

describe('producerSlugFromModelId', () => {
  test('path-prefixed qwen id', () => {
    assert.equal(producerSlugFromModelId('qwen/qwen3.5-9b'), 'qwen');
  });

  test('flat LM Studio qwen id', () => {
    assert.equal(producerSlugFromModelId('qwen3.5-9b'), 'qwen');
  });

  test('path-prefixed google gemma id', () => {
    assert.equal(producerSlugFromModelId('google/gemma-4-12b'), 'google');
  });

  test('flat gemma id', () => {
    assert.equal(producerSlugFromModelId('gemma-4-12b'), 'google');
  });

  test('meta-llama path alias resolves to meta', () => {
    assert.equal(producerSlugFromModelId('meta-llama/Llama-3.1-8B'), 'meta');
  });

  test('unknown model falls back to other', () => {
    assert.equal(producerSlugFromModelId('unknown-foo-bar'), 'other');
  });

  test('quantizer org path resolves maker from the model segment', () => {
    assert.equal(producerSlugFromModelId('lmstudio-community/gemma-4-12B-it-GGUF'), 'google');
    assert.equal(producerSlugFromModelId('hugging-quants/Llama-3.2-3B-Instruct-GGUF'), 'meta');
    assert.equal(producerSlugFromModelId('lmstudio-community/Qwen3.5-9B-GGUF'), 'qwen');
  });

  test('quantizer org alone is not a maker', () => {
    assert.equal(producerSlugFromModelId('lmstudio-community'), 'other');
    assert.equal(producerSlugFromModelId('hugging-quants'), 'other');
  });
});

describe('producerDisplayName', () => {
  test('known slugs', () => {
    assert.equal(producerDisplayName('qwen'), 'Qwen');
    assert.equal(producerDisplayName('google'), 'Google');
    assert.equal(producerDisplayName('meta'), 'Llama');
    assert.equal(producerDisplayName('other'), 'Other');
  });
});

describe('modelProducerLogoSvg', () => {
  test('known producers return SVG', () => {
    assert.ok(modelProducerLogoSvg('qwen/qwen3.5-9b'));
    assert.ok(modelProducerLogoSvg('qwen3.5-9b'));
    assert.ok(modelProducerLogoSvg('google/gemma-4-12b'));
    assert.ok(modelProducerLogoSvg('gemma-4-12b'));
    assert.ok(modelProducerLogoSvg('meta-llama/Llama-3.1-8B'));
  });

  test('unknown model returns null', () => {
    assert.equal(modelProducerLogoSvg('unknown-foo-bar'), null);
  });
});

describe('resolveModelProducer', () => {
  test('catalog ownership resolves Claude aliases with the Anthropic logo', () => {
    for (const id of ['sonnet', 'opus', 'haiku']) {
      const producer = resolveModelProducer(id, 'anthropic');
      assert.equal(producer.slug, 'anthropic');
      assert.equal(producer.displayName, 'Anthropic');
      assert.equal(producer.logoSvg, modelProducerLogoSvg('claude-opus-5-5'));
      assert.equal(resolveModelProducer(id).slug, 'other');
    }
  });

  test('unknown owners stay Other and gateway ownership does not override a known family', () => {
    assert.equal(resolveModelProducer('auto', 'cursor').slug, 'other');
    assert.equal(resolveModelProducer('unknown-model', 'unknown-org').logoSvg, null);
    assert.equal(resolveModelProducer('claude-opus-5-5', 'openai').slug, 'anthropic');
  });

  test('qwen path id', () => {
    const p = resolveModelProducer('qwen/qwen3.5-9b');
    assert.equal(p.slug, 'qwen');
    assert.equal(p.displayName, 'Qwen');
    assert.ok(p.logoSvg);
  });

  test('flat qwen id', () => {
    const p = resolveModelProducer('qwen3.5-9b');
    assert.equal(p.slug, 'qwen');
    assert.equal(p.displayName, 'Qwen');
    assert.ok(p.logoSvg);
  });

  test('unknown id', () => {
    const p = resolveModelProducer('unknown-foo-bar');
    assert.equal(p.slug, 'other');
    assert.equal(p.displayName, 'Other');
    assert.equal(p.logoSvg, null);
  });

  test('quantizer repo id matches logo and display name', () => {
    const p = resolveModelProducer('lmstudio-community/gemma-4-12B-it-GGUF');
    assert.equal(p.slug, 'google');
    assert.equal(p.displayName, 'Google');
    assert.ok(p.logoSvg);
  });
});
