/**
 * Brain code config normalization — repo map token budget bounds.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REPO_MAP_TOKEN_BUDGET_MAX,
  REPO_MAP_TOKEN_BUDGET_MIN,
  clampRepoMapInjectionTokenBudget,
  clampRepoMapTokenBudget,
  normalizeBrainCodeConfig,
} from '../../../server/brain/code/config.js';

describe('normalizeBrainCodeConfig', () => {
  it('clamps repoMapTokenBudget to the supported range', () => {
    assert.equal(
      normalizeBrainCodeConfig({ repoMapTokenBudget: 12_000 }).repoMapTokenBudget,
      12_000,
    );
    assert.equal(
      normalizeBrainCodeConfig({ repoMapTokenBudget: 200_000 }).repoMapTokenBudget,
      REPO_MAP_TOKEN_BUDGET_MAX,
    );
    assert.equal(
      normalizeBrainCodeConfig({ repoMapTokenBudget: 50 }).repoMapTokenBudget,
      REPO_MAP_TOKEN_BUDGET_MIN,
    );
  });

  it('clamps repoMapInjectionTokenBudget to the supported range', () => {
    assert.equal(
      normalizeBrainCodeConfig({ repoMapInjectionTokenBudget: 9000 }).repoMapInjectionTokenBudget,
      9000,
    );
    assert.equal(
      normalizeBrainCodeConfig({ repoMapInjectionTokenBudget: 50 }).repoMapInjectionTokenBudget,
      REPO_MAP_TOKEN_BUDGET_MIN,
    );
  });
});

describe('clampRepoMapTokenBudget', () => {
  it('floors fractional values and rejects non-finite input', () => {
    assert.equal(clampRepoMapTokenBudget(1500.9), 1500);
    assert.equal(clampRepoMapTokenBudget('nope'), 32000);
  });
});

describe('clampRepoMapInjectionTokenBudget', () => {
  it('defaults to injection budget when input is invalid', () => {
    assert.equal(clampRepoMapInjectionTokenBudget('nope'), 4000);
  });
});
