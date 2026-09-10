import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildPlanReviewerTask,
  planInvolvesUi,
  SUPER_PLAN_REVIEW_PASSES,
} from '../../../src/chat/super-plan/review-helpers.ts';
import { shouldRunImpeccableStage } from '../../../src/chat/super-plan/impeccable-stage.ts';

describe('planInvolvesUi heuristic', () => {
  test('returns false for backend-only text', () => {
    assert.equal(planInvolvesUi('Add API endpoint in server/routes.js', 'Migrate SQLite schema'), false);
  });
  test('returns true for component and route mentions', () => {
    assert.equal(planInvolvesUi('Update settings page component and add #/settings route'), true);
  });
  test('returns true for src/ui and CSS paths', () => {
    assert.equal(planInvolvesUi('Modify src/ui/mode-selector.ts and tokens.css'), true);
  });
  test('returns true for index.html', () => {
    assert.equal(planInvolvesUi('Wire new panel in index.html'), true);
  });
  test('returns false when all inputs empty', () => {
    assert.equal(planInvolvesUi(undefined, '', null), false);
  });
});

describe('shouldRunImpeccableStage', () => {
  test('mirrors planInvolvesUi on context fields', () => {
    assert.equal(shouldRunImpeccableStage({ draftPlan: '# Backend only\n\nRefactor server.js' }), false);
    assert.equal(shouldRunImpeccableStage({ draftPlan: '# Dashboard\n\nAdd chart component in src/ui/' }), true);
  });
});

describe('buildPlanReviewerTask', () => {
  test('pass 1 task includes draft plan and spec', () => {
    const task = buildPlanReviewerTask({
      pass: 1,
      draftPlan: '# My Plan\n\nWave 1 tasks…',
      spec: 'MVP: export button',
    });
    assert.ok(task.includes('pass 1'));
    assert.ok(task.includes('My Plan'));
    assert.ok(task.includes('MVP: export button'));
    assert.ok(!task.includes('Pass 1 critique'));
  });
  test('pass 2 task includes prior critique from pass 1', () => {
    const prior = '{"summary":"2 blockers","findings":[{"title":"Missing test"}]}';
    const task = buildPlanReviewerTask({ pass: 2, draftPlan: '# Revised plan', priorCritique: prior });
    assert.ok(task.includes('pass 2'));
    assert.ok(task.includes('Pass 1 critique'));
    assert.ok(task.includes(prior));
    assert.ok(task.includes('pass 1 missed'));
  });
  test('SUPER_PLAN_REVIEW_PASSES is two sequential passes', () => {
    assert.deepEqual([...SUPER_PLAN_REVIEW_PASSES], [1, 2]);
  });
});
