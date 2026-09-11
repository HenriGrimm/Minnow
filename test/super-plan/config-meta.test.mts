/**
 * Super Plan config defaults, parsing, and pipeline integration (Phase 6).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_SUPER_PLAN_CONFIG,
  getSuperPlanConfigSync,
  resetSuperPlanConfigCache,
  resolveSuperPlanResearchMaxRounds,
  saveSuperPlanConfig,
  setSuperPlanConfigForTests,
} from '../../src/config/super-plan-meta.ts';

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

describe('saved config reaches a new run', () => {
  test('startSuperPlan snapshots the Settings pipeline options into the run config', async () => {
    const { createEmptyChatObject, setSessionStateForTests } = await import('../../src/state/sessions.ts');
    const { startSuperPlan } = await import('../../src/chat/super-plan/client.ts');
    const { resetSuperPlanStoreForTests } = await import('../../src/chat/super-plan/store.ts');
    const { superPlanRunView } = await import('../helpers/super-plan-fixture.ts');
    resetSuperPlanConfigCache();
    setSuperPlanConfigForTests({
      ...DEFAULT_SUPER_PLAN_CONFIG,
      grillEnabled: false,
      grillQuestionBudget: 8,
      researchScope: 'codebase',
      reviewRounds: 3,
      impeccable: 'never',
      reviewerModel: { providerId: 'p', modelId: 'reviewer-model' },
    });
    const chat = createEmptyChatObject('m');
    chat.modeId = 'super-plan';
    chat.workspacePath = 'C:/work/app';
    setSessionStateForTests({ version: 5, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
    const bodies: Array<Record<string, any>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/super-plan' && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true, view: superPlanRunView('interviewing', { runId: 'run-new', chatId: chat.id }) });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    try {
      const view = await startSuperPlan(chat, 'Add offline queueing');
      assert.equal(view.runId, 'run-new');
      assert.equal(chat.superPlanRunId, 'run-new');
      assert.equal(chat.superPlanView?.runId, 'run-new');
      const config = bodies[0]?.config;
      assert.equal(bodies[0]?.prompt, 'Add offline queueing');
      assert.equal(bodies[0]?.chatId, chat.id);
      assert.equal(config.interview, false);
      assert.equal(config.questionBudget, 8);
      assert.equal(config.researchScope, 'codebase');
      assert.equal(config.reviewRounds, 3);
      assert.equal(config.polish, 'never');
      assert.deepEqual(config.reviewerModel, { providerId: 'p', modelId: 'reviewer-model' });
      assert.equal(config.researchModel, undefined, 'an unset stage model stays unset');
    } finally {
      globalThis.fetch = originalFetch;
      resetSuperPlanStoreForTests();
      setSessionStateForTests(null);
    }
  });
});
