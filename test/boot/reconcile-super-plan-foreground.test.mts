import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { reconcileBootForegroundAwayFromSuperPlan } from '../../src/boot/reconcile-super-plan-foreground.ts';
import { superPlanSummary } from '../helpers/super-plan-fixture.ts';
import { createEmptyChatObject, sessionState, setSessionStateForTests } from '../../src/state/sessions.ts';
import type { Chat } from '../../src/types.ts';

function makeGeneralChat(id: string): Chat {
  const chat = createEmptyChatObject('model');
  chat.id = id;
  chat.modeId = 'general';
  chat.history = [{ role: 'user', content: 'hello' }];
  return chat;
}

function makeEmptySuperPlanChat(id: string): Chat {
  const chat = createEmptyChatObject('model');
  chat.id = id;
  chat.modeId = 'super-plan';
  return chat;
}

function makeLiveSuperPlanChat(id: string): Chat {
  const chat = makeEmptySuperPlanChat(id);
  chat.superPlanRunId = 'engine-run';
  chat.superPlanView = superPlanSummary('researching', { runId: 'engine-run' });
  return chat;
}

describe('reconcileBootForegroundAwayFromSuperPlan', () => {
  test('moves activeId off a spare super-plan composer to the remembered general chat', () => {
    const general = makeGeneralChat('general');
    const spare = makeEmptySuperPlanChat('spare');
    setSessionStateForTests({
      activeId: 'spare',
      chats: [spare, general],
      lastActiveChatIdByWorkspace: { '': 'general' },
    });
    reconcileBootForegroundAwayFromSuperPlan();
    assert.equal(sessionState?.activeId, 'general');
  });

  test('keeps an in-flight super-plan run as the boot foreground', () => {
    const general = makeGeneralChat('general');
    const live = makeLiveSuperPlanChat('live');
    setSessionStateForTests({
      activeId: 'live',
      chats: [live, general],
      lastActiveChatIdByWorkspace: { '': 'general' },
    });
    reconcileBootForegroundAwayFromSuperPlan();
    assert.equal(sessionState?.activeId, 'live');
  });

  test('moves activeId off a finished run', () => {
    const general = makeGeneralChat('general');
    const done = makeEmptySuperPlanChat('done');
    done.superPlanRunId = 'engine-done';
    done.superPlanView = superPlanSummary('done', { runId: 'engine-done' });
    setSessionStateForTests({
      activeId: 'done',
      chats: [done, general],
      lastActiveChatIdByWorkspace: { '': 'general' },
    });
    reconcileBootForegroundAwayFromSuperPlan();
    assert.equal(sessionState?.activeId, 'general');
  });
});
