/**
 * Ephemeral empty chats stay out of sidebar lists until send or draft text.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatDraftChatSidebarName,
  getSidebarListedChatsForWorkspace,
  hasComposerDraft,
  isEphemeralEmptyChat,
  isSidebarListedChat,
  pruneEphemeralEmptyChats,
} from '../../src/state/session-workspace-scope.ts';
import { createEmptyChatObject } from '../../src/state/sessions.ts';
import { createSuperPlanState } from '../helpers/super-plan-fixture.ts';
import type { SessionState } from '../../src/types.ts';

const WS = 'C:\\workspace\\draft-sidebar';

function stateWithChats(...chats: ReturnType<typeof createEmptyChatObject>[]): SessionState {
  return {
    version: 5,
    activeId: chats[0]?.id ?? '',
    sidebarCollapsed: false,
    chats,
  };
}

describe('chat sidebar listing', () => {
  test('ephemeral empty chats are hidden from sidebar lists', () => {
    const fresh = createEmptyChatObject('', WS);
    assert.equal(isEphemeralEmptyChat(fresh), true);
    assert.equal(isSidebarListedChat(fresh), false);

    const state = stateWithChats(fresh);
    assert.deepEqual(getSidebarListedChatsForWorkspace(WS, state), []);
  });

  test('draft-only chats appear in sidebar lists', () => {
    const draft = createEmptyChatObject('', WS);
    draft.composerDraft = 'Fix the sidebar new-chat flow';
    assert.equal(isEphemeralEmptyChat(draft), false);
    assert.equal(hasComposerDraft(draft), true);
    assert.equal(isSidebarListedChat(draft), true);
    assert.equal(
      formatDraftChatSidebarName(draft),
      'Fix the sidebar new-chat flow',
    );

    const state = stateWithChats(draft);
    assert.equal(getSidebarListedChatsForWorkspace(WS, state).length, 1);
  });

  test('lazy-unloaded chats with messageCount appear in sidebar lists', () => {
    // C.2: summaries inflate history:[] — rails must use denormalized messageCount.
    const unloaded = createEmptyChatObject('', WS);
    unloaded.history = [];
    unloaded.historyLoaded = false;
    unloaded.messageCount = 3;
    unloaded.name = 'Prior chat';
    assert.equal(isEphemeralEmptyChat(unloaded), false);
    assert.equal(isSidebarListedChat(unloaded), true);

    const state = stateWithChats(unloaded);
    assert.equal(getSidebarListedChatsForWorkspace(WS, state).length, 1);
  });

  test('lazy-unloaded chats with messageCount 0 stay hidden', () => {
    const unloadedEmpty = createEmptyChatObject('', WS);
    unloadedEmpty.historyLoaded = false;
    unloadedEmpty.messageCount = 0;
    assert.equal(isEphemeralEmptyChat(unloadedEmpty), true);
    assert.equal(isSidebarListedChat(unloadedEmpty), false);
  });

  test('lazy-unloaded chats with missing messageCount stay listed (fail-safe)', () => {
    // If ensureChatShape drops messageCount, prefer a visible rail over prune wipe.
    const unloadedUnknown = createEmptyChatObject('', WS);
    unloadedUnknown.history = [];
    unloadedUnknown.historyLoaded = false;
    delete unloadedUnknown.messageCount;
    assert.equal(isEphemeralEmptyChat(unloadedUnknown), false);
    assert.equal(isSidebarListedChat(unloadedUnknown), true);

    const keep = createEmptyChatObject('', WS);
    keep.history.push({ role: 'user', content: 'anchor' });
    const state = stateWithChats(keep, unloadedUnknown);
    pruneEphemeralEmptyChats(state, keep.id);
    assert.ok(state.chats.some((c) => c.id === unloadedUnknown.id));
  });

  test('super-plan chats with pipeline state appear even with empty history', () => {
    const run = createEmptyChatObject('', WS);
    run.modeId = 'super-plan';
    run.superPlanView = createSuperPlanState('Add OAuth login');
    assert.equal(isEphemeralEmptyChat(run), false);
    assert.equal(isSidebarListedChat(run), true);

    const keep = createEmptyChatObject('', WS);
    keep.history.push({ role: 'user', content: 'anchor' });
    const state = stateWithChats(keep, run);
    pruneEphemeralEmptyChats(state, keep.id);
    assert.ok(state.chats.some((c) => c.id === run.id));
  });

  test('a blank super-plan composer without pipeline state stays hidden', () => {
    const spare = createEmptyChatObject('', WS);
    spare.modeId = 'super-plan';
    assert.equal(isEphemeralEmptyChat(spare), true);
    assert.equal(isSidebarListedChat(spare), false);
  });

  test('pruneEphemeralEmptyChats keeps the active row and listed chats', () => {
    const keep = createEmptyChatObject('', WS);
    const orphan = createEmptyChatObject('', WS);
    const listed = createEmptyChatObject('', WS);
    listed.history.push({ role: 'user', content: 'hello' });
    const draft = createEmptyChatObject('', WS);
    draft.composerDraft = 'still typing';

    const state = stateWithChats(keep, orphan, listed, draft);
    pruneEphemeralEmptyChats(state, keep.id);
    assert.equal(state.chats.length, 3);
    assert.ok(state.chats.some((c) => c.id === keep.id));
    assert.ok(state.chats.some((c) => c.id === listed.id));
    assert.ok(state.chats.some((c) => c.id === draft.id));
    assert.equal(state.chats.some((c) => c.id === orphan.id), false);
  });
});
