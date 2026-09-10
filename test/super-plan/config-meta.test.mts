/**
 * Super Plan config defaults, parsing, and pipeline integration (Phase 6).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_SUPER_PLAN_CONFIG,
  getSuperPlanConfigSync,
  getSuperPlanReviewPasses,
  resetSuperPlanConfigCache,
  resolveSuperPlanResearchMaxRounds,
  saveSuperPlanConfig,
  setSuperPlanConfigForTests,
} from '../../src/config/super-plan-meta.ts';
import { buildPlanReviewerTask } from '../../src/chat/super-plan/review-helpers.ts';

describe('DEFAULT_SUPER_PLAN_CONFIG', () => {
  test('matches Phase 6 spec defaults', () => {
    assert.deepEqual(DEFAULT_SUPER_PLAN_CONFIG, {
      reviewRounds: 2,
      grillEnabled: true,
      researchEnabled: true,
      grillQuestionBudget: 20,
      impeccable: 'auto',
      researchScope: 'both',
      researchMaxRounds: 0,
      researchDepth: 'auto',
      researchModel: { providerId: '', modelId: '' },
      reviewerModel: { providerId: '', modelId: '' },
      plannerModel: { providerId: '', modelId: '' },
      reviewTimeoutMs: 20 * 60 * 1000,
    });
  });
});

describe('resolveSuperPlanResearchMaxRounds', () => {
  test('explicit maxRounds wins over depth preset', () => {
    assert.equal(
      resolveSuperPlanResearchMaxRounds({
        ...DEFAULT_SUPER_PLAN_CONFIG,
        researchMaxRounds: 4,
        researchDepth: 'quick',
      }),
      4,
    );
  });

  test('depth presets when maxRounds is 0', () => {
    assert.equal(
      resolveSuperPlanResearchMaxRounds({
        ...DEFAULT_SUPER_PLAN_CONFIG,
        researchDepth: 'quick',
      }),
      2,
    );
    assert.equal(
      resolveSuperPlanResearchMaxRounds({
        ...DEFAULT_SUPER_PLAN_CONFIG,
        researchDepth: 'deep',
      }),
      5,
    );
    assert.equal(
      resolveSuperPlanResearchMaxRounds({
        ...DEFAULT_SUPER_PLAN_CONFIG,
        researchDepth: 'auto',
      }),
      0,
    );
  });
});

describe('saveSuperPlanConfig cache', () => {
  test('updates getSuperPlanConfigSync before the promise settles', () => {
    resetSuperPlanConfigCache();
    setSuperPlanConfigForTests({ ...DEFAULT_SUPER_PLAN_CONFIG });

    void saveSuperPlanConfig({ grillQuestionBudget: 12 }).catch(() => {
      /* server fetch may fail in unit tests; sync cache is what we assert */
    });

    assert.equal(getSuperPlanConfigSync().grillQuestionBudget, 12);
    assert.equal(getSuperPlanConfigSync().grillEnabled, true);
  });
});

describe('controller config accessors', () => {
  test('getSuperPlanReviewPasses reflects reviewRounds', () => {
    resetSuperPlanConfigCache();
    setSuperPlanConfigForTests({ ...DEFAULT_SUPER_PLAN_CONFIG, reviewRounds: 3 });
    assert.deepEqual(getSuperPlanReviewPasses({ ...DEFAULT_SUPER_PLAN_CONFIG, reviewRounds: 3 }), [
      1, 2, 3,
    ]);
  });

  test('buildPlanReviewerTask uses configured review round total', () => {
    const task = buildPlanReviewerTask({
      pass: 1,
      reviewRounds: 3,
      draftPlan: '# Plan',
    });
    assert.ok(task.includes('pass 1 of 3'));
  });
});
