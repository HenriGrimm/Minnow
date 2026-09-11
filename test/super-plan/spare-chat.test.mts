/**
 * Spare Plan / Super Plan composer reuse — live runs must never look "empty".
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isReusableEmptyPlanChat } from '../../src/chat/super-plan/spare-chat.ts';
import { superPlanSummary } from '../helpers/super-plan-fixture.ts';
import { createEmptyChatObject } from '../../src/state/sessions.ts';

describe('isReusableEmptyPlanChat', () => {
  test('a blank super-plan composer with no pipeline state is reusable', () => {
    const chat = createEmptyChatObject('spare');
    chat.modeId = 'super-plan';
    assert.equal(isReusableEmptyPlanChat(chat, 'super-plan'), true);
    assert.equal(isReusableEmptyPlanChat(chat, 'plan'), false);
  });

  test('a live Super Plan with empty history is not a spare', () => {
    const chat = createEmptyChatObject('live');
    chat.modeId = 'super-plan';
    chat.history = [];
    chat.superPlanView = superPlanSummary('interviewing');
    assert.equal(isReusableEmptyPlanChat(chat, 'super-plan'), false);
  });

  test('lazy-unloaded history with a message count is not a spare', () => {
    const chat = createEmptyChatObject('lazy');
    chat.modeId = 'super-plan';
    chat.history = [];
    chat.historyLoaded = false;
    chat.messageCount = 4;
    assert.equal(isReusableEmptyPlanChat(chat, 'super-plan'), false);
  });

  test('lazy-unloaded empty history without superPlan is still a spare', () => {
    const chat = createEmptyChatObject('lazy-empty');
    chat.modeId = 'super-plan';
    chat.historyLoaded = false;
    chat.messageCount = 0;
    assert.equal(isReusableEmptyPlanChat(chat, 'super-plan'), true);
  });

  test('cancelled or finished superPlan still blocks reuse', () => {
    const chat = createEmptyChatObject('done');
    chat.modeId = 'super-plan';
    chat.superPlanView = superPlanSummary('cancelled');
    assert.equal(isReusableEmptyPlanChat(chat, 'super-plan'), false);
  });

  test('a plan-mode chat with transcript is not reusable', () => {
    const chat = createEmptyChatObject('plan');
    chat.modeId = 'plan';
    chat.history.push({ role: 'user', content: 'hello' });
    assert.equal(isReusableEmptyPlanChat(chat, 'plan'), false);
  });
});
