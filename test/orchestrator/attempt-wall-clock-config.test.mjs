/**
 * Settings → Autopilot attempt time limit (`autopilot.attemptWallClockMs`):
 * config.json merge keeps a clamped value; `0` is a real "off", not junk.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeConfigMeta } from '../../server/config/validators.js';
import { ATTEMPT_WALL_CLOCK_MS } from '../../server/orchestrator/attempt-limits.js';

describe('autopilot.attemptWallClockMs', () => {
  it('reset to defaults carries the 240 minute attempt limit', () => {
    const merged = mergeConfigMeta({}, { autopilot: null });
    assert.equal(merged.autopilot.attemptWallClockMs, ATTEMPT_WALL_CLOCK_MS);
    assert.equal(ATTEMPT_WALL_CLOCK_MS, 240 * 60 * 1000);
  });

  it('stores a custom limit and clamps out-of-range values', () => {
    const custom = mergeConfigMeta({}, { autopilot: { attemptWallClockMs: 90 * 60 * 1000 } });
    assert.equal(custom.autopilot.attemptWallClockMs, 90 * 60 * 1000);

    const tooSmall = mergeConfigMeta({}, { autopilot: { attemptWallClockMs: 1000 } });
    assert.equal(tooSmall.autopilot.attemptWallClockMs, 5 * 60 * 1000);

    const tooLarge = mergeConfigMeta({}, { autopilot: { attemptWallClockMs: 7 * 24 * 60 * 60 * 1000 } });
    assert.equal(tooLarge.autopilot.attemptWallClockMs, 24 * 60 * 60 * 1000);
  });

  it('0 turns the limit off', () => {
    const off = mergeConfigMeta({}, { autopilot: { attemptWallClockMs: 0 } });
    assert.equal(off.autopilot.attemptWallClockMs, 0);
  });

  it('leaves a stored limit alone when the patch does not mention it', () => {
    const kept = mergeConfigMeta(
      { autopilot: { attemptWallClockMs: 60 * 60 * 1000 } },
      { autopilot: { maxConcurrentTasks: 2 } },
    );
    assert.equal(kept.autopilot.attemptWallClockMs, 60 * 60 * 1000);
  });
});
