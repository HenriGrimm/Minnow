import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { createSuperPlanState } from '../helpers/super-plan-fixture.ts';
import { SuperPlanTranscript } from '../../src/ui/super-plan-transcript.ts';
import { clearSuperPlanLiveTranscript, getSuperPlanLiveTranscript, observeSuperPlanTranscript } from '../../src/chat/super-plan/live-transcript.ts';

let window: Window;
let transcript: SuperPlanTranscript;
afterEach(() => { transcript?.destroy(); clearSuperPlanLiveTranscript('transcript'); setSessionStateForTests(null); window?.close(); });

test('runner snapshots replace text and reset runtime counts on retry', () => {
  observeSuperPlanTranscript('transcript', { type: 'delta', text: 'Hello' });
  observeSuperPlanTranscript('transcript', { type: 'delta', text: 'Hello world' });
  observeSuperPlanTranscript('transcript', { type: 'thinking', text: 'Consider' });
  observeSuperPlanTranscript('transcript', { type: 'thinking', text: 'Consider the requirements' });
  observeSuperPlanTranscript('transcript', { type: 'stream_meta', runtime: { timings: { predicted_n: 128 } } });
  const live = getSuperPlanLiveTranscript('transcript')!;
  assert.equal(live.text, 'Hello world');
  assert.equal(live.reasoning, 'Consider the requirements');
  assert.equal(live.detail, '128 tokens');
  observeSuperPlanTranscript('transcript', { type: 'response_restart' });
  assert.equal(getSuperPlanLiveTranscript('transcript')!.text, '');
  assert.equal(getSuperPlanLiveTranscript('transcript')!.detail, '');
});

test('transcript shows immediate status, markdown and hosted-model tokens without duplicate rows', async () => {
  window = new Window(); installHappyDomGlobals(window);
  const chat = createEmptyChatObject('transcript');
  chat.superPlanView = createSuperPlanState('Build a useful planner');
  chat.history = [{ role: 'user', content: 'Internal interview instructions', superPlanStage: 'grill' }];
  setSessionStateForTests({ version: 5, chats: [chat], activeId: chat.id, sidebarCollapsed: false });
  const host = document.createElement('div'); document.body.append(host);
  transcript = new SuperPlanTranscript(host, chat.id);
  assert.match(host.textContent!, /Generating response/);
  assert.doesNotMatch(host.textContent!, /Internal interview|Waiting for the first/);
  observeSuperPlanTranscript(chat.id, { type: 'delta', text: '**Requirements** are ready.' });
  observeSuperPlanTranscript(chat.id, { type: 'stream_meta', runtime: { timings: { predicted_n: 42 } } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(host.querySelector('strong')?.textContent, 'Requirements');
  assert.match(host.textContent!, /42 tokens/);
  assert.equal(host.querySelectorAll('.stream-status').length, 1);
  const prose = host.querySelector('.sp-transcript__live .transcript-view__assistant');
  observeSuperPlanTranscript(chat.id, { type: 'delta', text: '**Requirements** are ready. Next step.' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(host.querySelector('.sp-transcript__live .transcript-view__assistant'), prose);
  assert.equal(host.querySelectorAll('strong').length, 1);
  chat.superPlanView.gate = { gateId: 'q1', kind: 'question', question: 'Choose' };
  transcript.schedule();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((host.querySelector('.sp-transcript__live') as HTMLElement).hidden, true);
});
