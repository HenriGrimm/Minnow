/**
 * Super Plan display titles for library and run header.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createSuperPlanState, createInitialSuperPlanStages } from '../helpers/super-plan-fixture.ts';
import {
  resolveSuperPlanDisplayTitle,
  syncSuperPlanChatTitle,
} from '../../src/chat/super-plan/plan-library.ts';
import { createEmptyChatObject } from '../../src/state/sessions.ts';
import { PLACEHOLDER_CHAT_NAME } from '../../src/constants.ts';

describe('resolveSuperPlanDisplayTitle', () => {
  test('prefers displayTitle over prompt', () => {
    const sp = createSuperPlanState('A very long prompt that should not appear as the title');
    sp.displayTitle = 'OAuth Login';
    assert.equal(resolveSuperPlanDisplayTitle(sp), 'OAuth Login');
  });

  test('derives title from plan path when present', () => {
    const sp = createSuperPlanState('prompt');
    delete sp.displayTitle;
    sp.stages = createInitialSuperPlanStages();
    sp.planPath = 'documentation/plans/oauth-login-flow.md';
    assert.equal(
      resolveSuperPlanDisplayTitle(sp, sp.planPath),
      'Oauth login flow',
    );
  });
});

describe('syncSuperPlanChatTitle', () => {
  test('stamps an interim Plan slug title on a placeholder chat', () => {
    const chat = createEmptyChatObject('sp-title');
    chat.modeId = 'super-plan';
    chat.name = PLACEHOLDER_CHAT_NAME;
    chat.superPlanView = createSuperPlanState('Add OAuth login');
    assert.equal(syncSuperPlanChatTitle(chat), true);
    assert.match(chat.name, /^Plan [a-f0-9]{8}$/i);
  });

  test('does not overwrite a user-renamed chat', () => {
    const chat = createEmptyChatObject('sp-renamed');
    chat.modeId = 'super-plan';
    chat.name = 'My custom name';
    chat.superPlanView = createSuperPlanState('Add OAuth login');
    assert.equal(syncSuperPlanChatTitle(chat), false);
    assert.equal(chat.name, 'My custom name');
  });
});
