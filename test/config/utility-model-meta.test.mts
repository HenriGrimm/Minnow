import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_UTILITY_MODEL_CONFIG,
  parseUtilityModelBlock,
  utilityModelOverride,
} from '../../src/config/utility-model-meta.ts';
import { mergeConfigMeta } from '../../server/config/validators.js';

describe('utility model config', () => {
  test('defaults to no override', () => {
    assert.deepEqual(parseUtilityModelBlock(null), DEFAULT_UTILITY_MODEL_CONFIG);
    assert.equal(utilityModelOverride(DEFAULT_UTILITY_MODEL_CONFIG), null);
  });

  test('normalizes a configured override', () => {
    const parsed = parseUtilityModelBlock({
      providerId: ' provider ',
      modelId: ' model ',
    });
    assert.deepEqual(utilityModelOverride(parsed), {
      providerId: 'provider',
      modelId: 'model',
    });
  });

  test('server meta merge persists provider and model together', () => {
    const merged = mergeConfigMeta({}, {
      utilityModel: { providerId: 'local', modelId: 'small-model' },
    });
    assert.deepEqual(merged.utilityModel, {
      providerId: 'local',
      modelId: 'small-model',
    });
  });
});
