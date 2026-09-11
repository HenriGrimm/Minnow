/**
 * The renderer's Super Plan store: newest view wins, chat summaries follow
 * it, one alert per ask, and one stream per run however many views watch it.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import {
  applySuperPlanView,
  getSuperPlanRunView,
  resetSuperPlanStoreForTests,
  subscribeSuperPlanSummaries,
  watchSuperPlanRun,
} from '../../src/chat/super-plan/store.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { getNotifications, resetNotificationStoreForTests } from '../../src/notifications/store.ts';
import { attachSuperPlanRun, superPlanRunView } from '../helpers/super-plan-fixture.ts';
import type { Chat } from '../../src/types.ts';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
  close(): void {
    this.closed = true;
  }
}

let window: Window;
let chat: Chat;

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('super plan store', () => {
  beforeEach(() => {
    window = new Window();
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = window;
    g.document = window.document;
    g.localStorage = window.localStorage;
    g.EventSource = FakeEventSource;
    FakeEventSource.instances = [];
    chat = createEmptyChatObject('m');
    attachSuperPlanRun(chat, 'drafting', { runId: 'run-1' });
    chat.superPlanView = undefined;
    setSessionStateForTests({ version: 5, activeId: 'other', sidebarCollapsed: false, chats: [chat] });
    resetNotificationStoreForTests();
  });

  afterEach(() => {
    resetSuperPlanStoreForTests();
    resetNotificationStoreForTests();
    setSessionStateForTests(null);
    delete (globalThis as Record<string, unknown>).EventSource;
    window.close();
  });

  test('an older view never replaces a newer one, and the chat summary follows the newest', () => {
    const newer = superPlanRunView('reviewing', { runId: 'run-1', chatId: chat.id, seq: 50 });
    applySuperPlanView(newer);
    applySuperPlanView(superPlanRunView('drafting', { runId: 'run-1', chatId: chat.id, seq: 49 }));
    assert.equal(getSuperPlanRunView('run-1')?.current, 'review');
    assert.equal(chat.superPlanView?.stage, 'review');
    assert.equal(chat.superPlanView?.seq, 50);
    assert.equal(chat.superPlanRunId, 'run-1');
  });

  test('summary listeners hear every change', () => {
    const heard: string[] = [];
    const stop = subscribeSuperPlanSummaries((runId) => heard.push(runId));
    applySuperPlanView(superPlanRunView('drafting', { runId: 'run-1', chatId: chat.id, seq: 1 }));
    stop();
    applySuperPlanView(superPlanRunView('reviewing', { runId: 'run-1', chatId: chat.id, seq: 2 }));
    assert.deepEqual(heard, ['run-1']);
  });

  test('one alert per ask: none on first sight, one when the run starts waiting, none on repeats', async () => {
    applySuperPlanView(superPlanRunView('accept', { runId: 'run-1', chatId: chat.id, seq: 1, attentionKey: 'accept:1' }));
    await tick();
    assert.equal(getNotifications().length, 0, 'a run already waiting at load is shown by the sidebar, not announced');

    applySuperPlanView(superPlanRunView('drafting', { runId: 'run-1', chatId: chat.id, seq: 2, attentionKey: '' }));
    applySuperPlanView(superPlanRunView('accept', { runId: 'run-1', chatId: chat.id, seq: 3, attentionKey: 'accept:2' }));
    applySuperPlanView(superPlanRunView('accept', { runId: 'run-1', chatId: chat.id, seq: 4, attentionKey: 'accept:2' }));
    await tick();
    const alerts = getNotifications();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.kind, 'chat_question');
    assert.match(alerts[0]?.preview ?? '', /plan is ready/i);
    assert.equal(alerts[0]?.chatId, chat.id);
  });

  test('a halted stage alerts as an error', async () => {
    applySuperPlanView(superPlanRunView('drafting', { runId: 'run-1', chatId: chat.id, seq: 1 }));
    applySuperPlanView(superPlanRunView('halted', { runId: 'run-1', chatId: chat.id, seq: 2, attentionKey: 'halted:1' }));
    await tick();
    assert.equal(getNotifications()[0]?.kind, 'chat_turn_error');
  });

  test('views of one run share a stream, and it closes when the last one leaves', () => {
    const frames: string[] = [];
    const releaseA = watchSuperPlanRun('run-1', (frame) => frames.push(`a:${frame.event.type}`));
    const releaseB = watchSuperPlanRun('run-1', (frame) => frames.push(`b:${frame.event.type}`));
    assert.equal(FakeEventSource.instances.length, 1);
    const source = FakeEventSource.instances[0]!;

    source.emit('view', superPlanRunView('reviewing', { runId: 'run-1', chatId: chat.id, seq: 9 }));
    assert.equal(getSuperPlanRunView('run-1')?.seq, 9, 'a pushed view lands in the store');
    source.emit('live', { runId: 'run-1', stage: 'review', event: { type: 'delta', text: 'x' } });
    assert.deepEqual(frames, ['a:delta', 'b:delta']);

    releaseA();
    releaseA();
    assert.equal(source.closed, false, 'releasing twice does not steal the other view’s reference');
    releaseB();
    assert.equal(source.closed, true);
  });
});
