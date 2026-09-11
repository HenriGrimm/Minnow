/**
 * Super Plan display titles for the library rail and the chat sidebar.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { superPlanSummary } from '../helpers/super-plan-fixture.ts';
import {
  resolveSuperPlanDisplayTitle,
  syncSuperPlanChatTitle,
} from '../../src/chat/super-plan/plan-library.ts';
import { createEmptyChatObject } from '../../src/state/sessions.ts';
import { PLACEHOLDER_CHAT_NAME } from '../../src/constants.ts';

describe('resolveSuperPlanDisplayTitle', () => {
  test('uses the run title, never the prompt', () => {
    const sp = superPlanSummary('drafting', { title: 'OAuth login' });
    assert.equal(resolveSuperPlanDisplayTitle(sp), 'OAuth login');
  });

  test('falls back to the plan file name', () => {
    const sp = superPlanSummary('drafting', { title: '', planPath: 'documentation/plans/oauth-login-flow.md' });
    assert.equal(resolveSuperPlanDisplayTitle(sp), 'Oauth login flow');
  });

  test('says untitled rather than showing a paragraph of prompt', () => {
    const sp = superPlanSummary('interviewing', { title: '', planPath: undefined });
    assert.equal(resolveSuperPlanDisplayTitle(sp), 'Untitled plan');
  });
});

describe('syncSuperPlanChatTitle', () => {
  test('names a placeholder chat after its run', () => {
    const chat = createEmptyChatObject('sp-title');
    chat.modeId = 'super-plan';
    chat.name = PLACEHOLDER_CHAT_NAME;
    chat.superPlanView = superPlanSummary('drafting', { title: 'Offline sync queue' });
    assert.equal(syncSuperPlanChatTitle(chat), true);
    assert.equal(chat.name, 'Offline sync queue');
  });

  test('follows a later rename of the run while the name is still managed', () => {
    const chat = createEmptyChatObject('sp-follow');
    chat.modeId = 'super-plan';
    chat.name = 'Offline sync queue';
    chat.superPlanView = superPlanSummary('drafting', { title: 'Offline edit queue' });
    assert.equal(syncSuperPlanChatTitle(chat, 'Offline sync queue'), true);
    assert.equal(chat.name, 'Offline edit queue');
  });

  test('does not overwrite a user-renamed chat', () => {
    const chat = createEmptyChatObject('sp-renamed');
    chat.modeId = 'super-plan';
    chat.name = 'My custom name';
    chat.superPlanView = superPlanSummary('drafting', { title: 'Offline sync queue' });
    assert.equal(syncSuperPlanChatTitle(chat, 'Something else'), false);
    assert.equal(chat.name, 'My custom name');
  });
});
