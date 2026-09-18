import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULT_META } from '../../server/config/home.js';
import { mergeConfigMeta } from '../../server/config/validators.js';

describe('Flaticon icon guidance config', () => {
  test('is enabled for new homes', () => {
    assert.equal(DEFAULT_META.flaticonIconGuidanceEnabled, true);
  });

  test('persists an explicit disabled value', () => {
    const merged = mergeConfigMeta(DEFAULT_META, {
      flaticonIconGuidanceEnabled: false,
    });
    assert.equal(merged.flaticonIconGuidanceEnabled, false);
  });
});
