import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createConversationView } from '../../src/chat/conversation-view.ts';
import { adaptAttemptConversation } from '../../src/orchestrator/transcript-adapter.ts';
import { sessionState } from '../../src/state/sessions.ts';
import type { TurnEvent } from '../../server/runner/run-turn';

const views: ReturnType<typeof createConversationView>[] = [];
afterEach(() => { views.splice(0).forEach(view => view.dispose()); document.body.replaceChildren(); });

function setup(id = 'attempt') {
  const mount = document.createElement('div');
  document.body.append(mount);
  const collapsed = new Set<string>(), tools = new Set<string>();
  const view = createConversationView(mount, { id, modeId: 'build' }, {
    isThoughtExpanded: key => !collapsed.has(key),
    onThoughtExpandedChange: (key, expanded) => { if (expanded) collapsed.delete(key); else collapsed.add(key); },
    isToolExpanded: key => tools.has(key),
    onToolExpandedChange: (key, expanded) => { if (expanded) tools.add(key); else tools.delete(key); },
  });
  views.push(view);
  return { view, mount };
}

function round(index: number, text = '', reasoning = '', toolCallCount = 0): Extract<TurnEvent, { type: 'round_end' }> {
  return { type: 'round_end', index, text, reasoning, toolCallCount, t0: 0, tFirst: null, tEnd: 1 };
}

test('summary activity survives expansion and history reopens with the summary label', () => {
  const { view, mount } = setup();
  const thinking: TurnEvent = { type: 'thinking', text: '**Checking files**', reasoningFormat: 'summary' };
  view.sync(adaptAttemptConversation([thinking], true));
  assert.equal(mount.querySelector('.thoughts-toggle__label')?.textContent, 'Reasoning summary');
  assert.ok(mount.querySelector('.reasoning-summary-activity'));
  view.setPhase('thinking');
  assert.ok(mount.querySelector('.reasoning-summary-activity'));
  const end: TurnEvent = { ...round(0, 'Finished.', thinking.text), reasoningFormat: 'summary' };
  view.onEvent(end, 0);
  assert.equal(mount.querySelector('.reasoning-summary-activity'), null);
  assert.equal(mount.querySelector('.thoughts-toggle__label')?.textContent, 'Reasoning summary');
  view.sync(adaptAttemptConversation([thinking, end], false));
  assert.equal(mount.querySelector('.thoughts-toggle__label')?.textContent, 'Reasoning summary');
  assert.equal(mount.querySelector('.thoughts-caret--pulse'), null);
});

test('history uses main-chat rows, Markdown, thoughts, and tool batches without selecting a chat', () => {
  const before = sessionState;
  const { view, mount } = setup();
  const events = [
    { type: 'thinking', text: 'Inspect **both** files.' },
    { type: 'tool_call', id: 'a', name: 'read_file', arguments: { path: 'a.ts' } },
    { type: 'tool_call', id: 'b', name: 'read_file', arguments: { path: 'b.ts' } },
    { type: 'tool_result', id: 'a', content: 'A' },
    { type: 'tool_result', id: 'b', content: 'B' },
    round(0, 'Found `the source`.', 'Inspect **both** files.', 2),
  ];
  view.sync(adaptAttemptConversation(events, false));
  assert.equal(sessionState, before);
  assert.equal(mount.querySelector('.thoughts-content strong')?.textContent, 'both');
  assert.equal(mount.querySelector('.msg.assistant .msg-bubble code')?.textContent, 'the source');
  assert.equal(mount.querySelectorAll('.tool-call-msg--ok').length, 2);
  assert.ok(mount.querySelector('.tool-call-batch'));
  assert.equal(mount.querySelector('.msg-actions'), null);
  assert.equal(mount.querySelector('[class*="transcript-view__"]'), null);
});

test('live reasoning, prose and tools survive stale polls and reconcile without duplicate messages', () => {
  const { view, mount } = setup();
  view.sync(adaptAttemptConversation([], true));
  const events: TurnEvent[] = [
    { type: 'thinking', text: 'First thought.' },
    { type: 'reasoning_end' },
    { type: 'delta', text: 'Read **this**.' },
    { type: 'tool_call', id: 'read', name: 'read_file', arguments: { path: 'a.ts' } },
    { type: 'tool_result', id: 'read', name: 'read_file', content: 'source' },
    round(0, 'Read **this**.', 'First thought.', 1),
  ];
  events.forEach(event => view.onEvent(event, 0));
  view.onEvent({ type: 'thinking', text: 'Next thought, complete.' }, 1);
  view.flush();
  const live = mount.querySelectorAll('.thoughts-content')[1];
  view.sync(adaptAttemptConversation([], true));
  assert.equal(mount.querySelectorAll('.thoughts-content')[1], live);
  view.sync(adaptAttemptConversation([...events, { type: 'thinking', text: 'Next' }], true));
  assert.equal(mount.querySelectorAll('.tool-call-msg').length, 1);
  assert.equal(mount.querySelectorAll('.msg-bubble strong').length, 1);
  assert.equal(mount.querySelectorAll('.thoughts-content').length, 2);
  assert.equal(mount.querySelectorAll('.thoughts-content')[1].textContent?.trim(), 'Next thought, complete.');
  view.onEvent(round(1, 'Finished.', 'Next thought, complete.'), 1);
  assert.equal(mount.querySelectorAll('.msg-bubble')[1].textContent?.trim(), 'Finished.');
});

test('mounted conversations cannot resolve another attempt or main chat tool with the same id', () => {
  const first = setup('first'), second = setup('second');
  const main = document.createElement('div');
  main.id = 'chatArea';
  main.innerHTML = '<div data-tool-call-id="shared">Main chat stays here.</div>';
  document.body.append(main);
  for (const { view } of [first, second]) {
    view.sync(adaptAttemptConversation([], true));
    view.onEvent({ type: 'tool_call', id: 'shared', name: 'read_file', arguments: { path: 'a.ts' } }, 0);
  }
  first.view.onEvent({ type: 'tool_result', id: 'shared', name: 'read_file', content: 'First result.' }, 0);
  assert.ok(first.mount.querySelector('.tool-call-msg--ok'));
  assert.equal(second.mount.querySelector('.tool-call-msg--ok'), null);
  assert.equal(main.textContent, 'Main chat stays here.');
});

test('settled-only reasoning and disclosure choices survive snapshot repaint and reopen', () => {
  const { view, mount } = setup();
  view.sync(adaptAttemptConversation([], true));
  view.onEvent(round(0, 'Answer.', 'Returned only on completion.'), 0);
  const toggle = mount.querySelector<HTMLButtonElement>('.thoughts-toggle')!;
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.click();
  view.sync(adaptAttemptConversation([round(0, 'Answer.', 'Returned only on completion.')], false));
  assert.equal(mount.querySelector('.thoughts-toggle')?.getAttribute('aria-expanded'), 'false');
  assert.equal(mount.querySelectorAll('.thoughts-toggle').length, 1);
  assert.equal(mount.querySelector('.msg-bubble')?.textContent?.trim(), 'Answer.');
});

test('pause and resume retain unfinished tool disclosure and display the correct activity', () => {
  const { view, mount } = setup();
  const events = [{ type: 'tool_call', id: 'pending', name: 'read_file', arguments: { path: 'a.ts' } }];
  view.sync(adaptAttemptConversation(events, true));
  const details = mount.querySelector<HTMLDetailsElement>('.tool-call-details')!;
  details.open = true;
  details.dispatchEvent(new window.Event('toggle'));
  view.sync({ ...adaptAttemptConversation(events, false), pendingToolStatus: 'paused' });
  assert.equal(mount.querySelector('.tool-call-msg[aria-busy]'), null);
  assert.equal(mount.querySelector<HTMLDetailsElement>('.tool-call-details')?.open, true);
  view.sync(adaptAttemptConversation(events, true));
  assert.ok(mount.querySelector('.tool-call-msg[aria-busy]'));
  assert.equal(mount.querySelector<HTMLDetailsElement>('.tool-call-details')?.open, true);
});

test('disposing an attempt cancels queued stream paints and ignores late events', async () => {
  const { view, mount } = setup();
  view.sync(adaptAttemptConversation([], true));
  view.onEvent({ type: 'thinking', text: 'Pending paint.' }, 0);
  view.dispose();
  const html = mount.innerHTML;
  view.onEvent({ type: 'delta', text: 'Late response.' }, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(mount.innerHTML, html);
});

test('pausing and resuming behind live round completion preserves the unpolled conversation', () => {
  const { view, mount } = setup();
  const stale = adaptAttemptConversation([], true);
  view.sync(stale);
  view.onEvent({ type: 'thinking', text: 'Finished the first step.' }, 0);
  view.onEvent(round(0, 'First response.', 'Finished the first step.'), 0);
  view.onEvent({ type: 'thinking', text: 'Currently checking.' }, 1);
  view.onEvent({ type: 'tool_call', id: 'pending', name: 'read_file', arguments: { path: 'b.ts' } }, 1);
  view.sync({ ...stale, isLive: false, pendingToolStatus: 'paused' });
  assert.match(mount.textContent!, /First response/);
  assert.match(mount.textContent!, /Currently checking/);
  assert.equal(mount.querySelectorAll('.tool-call-msg').length, 1);
  assert.equal(mount.querySelector('.tool-call-msg[aria-busy]'), null);
  view.sync(stale);
  view.onEvent({ type: 'tool_result', id: 'pending', name: 'read_file', content: 'Result after resuming.' }, 1);
  view.onEvent(round(1, 'Second response.', 'Currently checking.', 1), 1);
  assert.equal(mount.querySelectorAll('.tool-call-msg').length, 1);
  assert.ok(mount.querySelector('.tool-call-msg--ok'));
  assert.match(mount.textContent!, /First response/);
  assert.match(mount.textContent!, /Second response/);
});

test('a thought collapsed during streaming stays collapsed when the round settles', () => {
  const { view, mount } = setup();
  view.sync(adaptAttemptConversation([], true));
  view.onEvent({ type: 'thinking', text: 'Live thought.' }, 0);
  view.flush();
  view.setPhase('thinking');
  assert.equal(mount.querySelector('.stream-status:not(.hidden)'), null, 'the Thoughts panel owns the live thinking label');
  mount.querySelector<HTMLButtonElement>('.thoughts-toggle')!.click();
  view.onEvent(round(0, 'Response.', 'Live thought.'), 0);
  assert.equal(mount.querySelector('.thoughts-toggle')?.getAttribute('aria-expanded'), 'false');
});

test('compaction checkpoints use the main chat divider while the following round remains live', () => {
  const { view, mount } = setup();
  view.sync(adaptAttemptConversation([round(0, 'Earlier response.'), {
    type: 'context_compaction', trigger: 'auto', summary: 'Keep the task constraints.',
    droppedTurns: 1, tokensBefore: 1000, tokensAfter: 500,
  }, { type: 'thinking', text: 'Continuing from the checkpoint.' }], true));
  assert.ok(mount.querySelector('.compaction-divider'));
  assert.match(mount.textContent!, /Continuing from the checkpoint/);
});
