import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, setupMinimalComposerDom } from '../os/dom-helpers.mts';
import { createEmptyChatObject, resetSessionPersistenceForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { isHiddenTranscriptUserMessage } from '../../src/chat/hidden-transcript-user-messages.ts';
import { collectTranscriptTurns } from '../../src/chat/transcript-turns.ts';
import { setSubAgentApiFetchForTests } from '../../src/agents/orchestrator.ts';
import { createAttributedAgentMessage, syncAgentConversationHeader } from '../../src/ui/agent-conversation.ts';
import { batchPersistentAgentActivity, clearPersistentAgentActivity, persistentAgentActivityOwner, refreshPersistentAgentActivity, upsertPersistentAgentActivity } from '../../src/ui/persistent-agent-activity.ts';
import { renderChatFromHistory } from '../../src/ui/messages.ts';
import { attachMessageActions, closeMessageActionsMenu, completePendingMessageEdit, remakeAssistantRow } from '../../src/ui/message-actions.ts';
import { attachBranchPicker } from '../../src/ui/branch-picker.ts';
import { activateBranch } from '../../src/state/runs-store.ts';
import { truncateChatHistory, updateUserMessageAt } from '../../src/chat/history-truncate.ts';
import { forkFromUserIndex } from '../../src/chat/fork-from-run.ts';
import { getUndoEligibility, undoLastAgentTurn } from '../../src/chat/undo-turn.ts';
import type { Chat, UserMessage } from '../../src/types.ts';
import type { SubAgentRun } from '../../src/agents/types.ts';

let win: Window | undefined;
const priorFetch = globalThis.fetch;
function shell(id: string, parentId?: string): Chat {
  const chat = createEmptyChatObject('selected-model', 'C:/fixture'); chat.id = id; chat.name = id;
  if (parentId) {
    chat.chatCommandVersion = 1;
    chat.agentConversation = { version: 1, childChatId: id, parentChatId: parentId, rootChatId: 'parent', journalOwnerId: 'parent', origin: 'delegated', createdAt: 1,
      capabilities: { canSend: true, canStop: true, canChooseModel: true }, initialRunId: `task-${id}` };
  }
  return chat;
}
function setup(chats: Chat[], activeId = chats[0]!.id): HTMLElement {
  win = new Window({ url: 'http://localhost:9473/#/app/code/chat' }); installHappyDomGlobals(win);
  document.body.innerHTML = ''; setupMinimalComposerDom(document);
  globalThis.fetch = (async () => Response.json({ runs: [] })) as typeof fetch;
  setSubAgentApiFetchForTests((async () => Response.json({ runs: [] })) as typeof fetch);
  setSessionStateForTests({ ...defaultSessionState(), chats, activeId });
  return document.getElementById('chatArea')!;
}
function run(id: string, childId: string, turn = 'parent-turn'): SubAgentRun {
  return { runId: id, childChatId: childId, journalOwnerId: 'parent', parentChatId: 'parent', parentTurnId: turn, parentToolCallId: `spawn-${id}`,
    type: 'explore', task: `Inspect ${childId}`, status: 'running', summary: '', error: null, startedAt: '2026-10-30T10:00:00.000Z', endedAt: null,
    toolTurns: 0, cancelled: false, messages: [], providerId: 'provider', modelId: 'model-a', executionId: `execution-${id}`,
    completionPolicy: { version: 1, kind: 'wake_delegator', recipientChatId: 'parent', subscriptionId: `subscription-${id}`, cancellationEpoch: 0 } };
}
function anchors(area: HTMLElement, runs: SubAgentRun[]): void {
  const batch = document.createElement('div'); batch.className = 'tool-call-batch';
  const body = document.createElement('div'); body.className = 'tool-call-batch__body'; batch.append(body);
  for (const run of runs) { const row = document.createElement('div'); row.className = 'tool-call-msg'; row.dataset.toolCallId = run.parentToolCallId!; body.append(row); }
  const answer = document.createElement('div'); answer.className = 'msg assistant'; answer.textContent = 'The parent answer stays here.'; area.append(batch, answer);
}
afterEach(async () => {
  await import('../../src/state/issues-store.ts');
  clearPersistentAgentActivity(); resetSessionPersistenceForTests(); setSessionStateForTests(null); setSubAgentApiFetchForTests(null);
  closeMessageActionsMenu();
  await win?.happyDOM.close(); win = undefined; globalThis.fetch = priorFetch;
});

test('managed and native transcripts expose copy without unsupported local history mutations', async () => {
  for (const origin of ['delegated', 'native'] as const) {
    const parent = shell('parent'), child = shell(`immutable-${origin}`, parent.id);
    child.agentConversation!.origin = origin;
    child.history = [{ role: 'user', content: 'Keep the saved assignment.' }, { role: 'assistant', content: 'Keep the saved answer.' }];
    child.composerDraft = 'Keep my unsent draft.';
    const area = setup([parent, child], child.id);
    for (const [historyIndex, turnKind] of [[0, 'user'], [1, 'assistant']] as const) {
      const row = document.createElement('div'); row.className = `msg ${turnKind}`;
      row.innerHTML = '<div class="msg-bubble">Saved text</div>'; area.append(row);
      attachMessageActions(row, { chatId: child.id, historyIndex, turnKind });
      attachBranchPicker(row, child.id, 0);
      row.querySelector<HTMLButtonElement>('.message-actions__trigger')!.click();
      const menu = document.querySelector('.message-actions__menu')!;
      assert.deepEqual([...menu.querySelectorAll('button')].map(button => button.textContent), ['Copy']);
      assert.equal(row.querySelector('.branch-picker__trigger'), null);
      closeMessageActionsMenu();
    }
    const before = structuredClone(child.history);
    assert.equal(truncateChatHistory(child.id, 0, 'inclusive').error, 'canonical_history');
    assert.equal(updateUserMessageAt(child.id, 0, 'Overwrite'), false);
    assert.equal(activateBranch(child, 0, 'old-branch'), false);
    assert.equal(getUndoEligibility(child).reason, 'canonical_history');
    assert.equal((await undoLastAgentTurn(child.id, { git: { snapshotRestore: async () => { throw new Error('Must never restore'); } } })).error, 'canonical_history');
    await forkFromUserIndex(child.id, 0);
    remakeAssistantRow(child.id, 1);
    await completePendingMessageEdit(child.id, 0, 'Overwrite');
    assert.deepEqual(child.history, before);
    assert.equal(child.composerDraft, 'Keep my unsent draft.');
    await win?.happyDOM.close(); win = undefined;
  }
});

test('background managed updates tolerate a mode-only surface without creating a transcript or request host', () => {
  const parent = shell('parent'), child = shell('unmounted-child', parent.id); setup([parent, child], child.id);
  document.body.innerHTML = '<div id="modeSelector"></div>';
  child.agentRequestSummary = [{ requestId: 'background-question', kind: 'question' }];
  assert.doesNotThrow(() => renderChatFromHistory(child));
  assert.equal(document.querySelector('.managed-chat-requests'), null); assert.equal(document.querySelector('.agent-chat-context'), null);
});

test('one persistent delegation is a direct child link; same-turn siblings form one keyed group and retain per-call anchors', () => {
  const parent = shell('parent'), a = shell('child-a', parent.id), b = shell('child-b', parent.id); const area = setup([parent, a, b]);
  const first = run('activity-one', a.id), second = run('activity-two', b.id); anchors(area, [first, second]);
  const row = upsertPersistentAgentActivity(first, parent.id, area)!;
  assert.equal(area.querySelector('.sub-agent-group'), null);
  assert.equal(row.querySelector('a')?.getAttribute('href'), '#/app/code/chat?chatId=child-a');
  upsertPersistentAgentActivity(second, parent.id, area);
  const group = area.querySelector<HTMLDetailsElement>('.sub-agent-group')!;
  assert.ok(group); assert.equal(group.querySelectorAll('.sub-agent-card').length, 2);
  assert.equal(group.querySelector('.sub-agent-card'), row);
  assert.equal(group.dataset.parentTurnId, 'parent-turn');
  assert.match(group.querySelector('summary')!.textContent!, /2 agents · 2 working/);
  assert.equal(area.querySelectorAll('.tool-call-msg--delegated').length, 2);
  assert.equal(row.dataset.parentToolCallId, first.parentToolCallId);
  assert.equal(group.nextElementSibling?.textContent, 'The parent answer stays here.');
  const link = row.querySelector<HTMLAnchorElement>('a')!; link.focus();
  upsertPersistentAgentActivity({ ...first, modelOptions: { reasoningEffort: 'high' } }, parent.id, area);
  assert.equal(document.activeElement, link); assert.match(row.textContent!, /effort high/);
});

test('unrelated turns never merge; queued and durable request waits have honest labels without generating spinners', () => {
  const parent = shell('parent'), a = shell('child-a', parent.id), b = shell('child-b', parent.id), c = shell('child-c', parent.id); const area = setup([parent, a, b, c]);
  const first = run('wait-one', a.id), second = run('wait-two', b.id), other = run('wait-three', c.id, 'different-turn');
  first.status = 'queued'; b.agentExecution = { executionId: second.executionId!, status: 'waiting_for_input' };
  b.agentRequestSummary = [{ requestId: 'question', kind: 'question' }]; anchors(area, [first, second, other]);
  batchPersistentAgentActivity(() => { for (const item of [first, second, other]) upsertPersistentAgentActivity(item, parent.id, area); });
  assert.equal(area.querySelectorAll('.sub-agent-group').length, 1);
  assert.equal(area.querySelectorAll('.sub-agent-group .sub-agent-card').length, 2);
  assert.match(area.querySelector('.sub-agent-group > summary')!.textContent!, /1 queued · 1 need attention/);
  const waiting = [...area.querySelectorAll<HTMLElement>('.sub-agent-card')].find(row => row.dataset.runId === second.runId)!;
  assert.match(waiting.textContent!, /Needs your answer/); assert.equal(waiting.getAttribute('aria-busy'), 'false');
  assert.equal(waiting.classList.contains('sub-agent-card--active'), false, 'request waits must not inflate the Worked running tally');
  const queued = [...area.querySelectorAll<HTMLElement>('.sub-agent-card')].find(row => row.dataset.runId === first.runId)!;
  assert.equal(queued.classList.contains('sub-agent-card--active'), false);
  b.agentExecution.status = 'waiting_for_host'; b.agentRequestSummary = []; refreshPersistentAgentActivity(parent.id, area);
  assert.match(waiting.textContent!, /Waiting for host/); assert.equal(waiting.getAttribute('aria-busy'), 'false');
  assert.equal(waiting.classList.contains('sub-agent-card--active'), false);
});

test('old task results remain immutable when the same child continues, and local-only work does not add a parent delegation', () => {
  const parent = shell('parent'), child = shell('child', parent.id); const area = setup([parent, child]);
  const completed = { ...run('completed-task', child.id), status: 'completed' as const, summary: 'Original published result.' };
  const row = upsertPersistentAgentActivity(completed, parent.id, area)!;
  child.agentExecution = { executionId: 'a-later-execution', status: 'running' }; refreshPersistentAgentActivity(parent.id, area);
  assert.match(row.textContent!, /Complete/); assert.match(row.textContent!, /Original published result/);
  assert.equal(row.classList.contains('sub-agent-card--active'), false);
  const followup = { ...run('follow-up-task', child.id), completionPolicy: { version: 1 as const, kind: 'local_only' as const } };
  assert.equal(persistentAgentActivityOwner(followup), null); assert.equal(upsertPersistentAgentActivity(followup, parent.id, area), null);
  assert.equal(area.querySelectorAll('.sub-agent-card').length, 1);
});

test('pool-backed activity distinguishes the captured pool, actual member and semantic options', () => {
  const parent = shell('pool-parent'), child = shell('pool-child', parent.id); const area = setup([parent, child]);
  const task = { ...run('pool-task', child.id), parentChatId: parent.id, providerId: 'minnow-router', modelId: 'review-pool',
    resolvedModel: { providerId: 'provider', id: 'actual-review-model' }, modelOptions: { reasoningEffort: 'high', thinkingMode: 'on' as const },
    completionPolicy: { version: 1 as const, kind: 'wake_delegator' as const, recipientChatId: parent.id, subscriptionId: 'pool-subscription', cancellationEpoch: 0 } };
  const row = upsertPersistentAgentActivity(task, parent.id, area)!;
  assert.match(row.textContent!, /Pool review-pool → actual-review-model/); assert.match(row.textContent!, /effort high/); assert.match(row.textContent!, /thinking on/);
});

test('group disclosure survives transcript rebuilding and child deletion preserves the original task link and result', () => {
  const parent = shell('parent'), a = shell('child-a', parent.id), b = shell('child-b', parent.id); const area = setup([parent, a, b]);
  const runs = [run('retained-one', a.id), run('retained-two', b.id)]; anchors(area, runs);
  batchPersistentAgentActivity(() => runs.forEach(item => upsertPersistentAgentActivity(item, parent.id, area)));
  const group = area.querySelector<HTMLDetailsElement>('.sub-agent-group')!; group.open = false; group.dispatchEvent(new win!.Event('toggle'));
  clearPersistentAgentActivity(); area.replaceChildren(); anchors(area, runs);
  batchPersistentAgentActivity(() => runs.forEach(item => upsertPersistentAgentActivity(item, parent.id, area)));
  assert.equal(area.querySelector<HTMLDetailsElement>('.sub-agent-group')!.open, false);
  const missing = { ...run('deleted-target', 'missing-child'), status: 'completed' as const, summary: 'Captured result stays available.' };
  const row = upsertPersistentAgentActivity(missing, parent.id, area)!;
  assert.ok(row); assert.match(row.textContent!, /Captured result stays available/);
  assert.match(row.querySelector('a')!.href, /chatId=missing-child/);
});

test('a history refresh preserves focused delegation disclosure and keeps persistent agents visible in compact Worked view', () => {
  const parent = shell('focus-parent'), a = shell('focus-a', parent.id), b = shell('focus-b', parent.id); const area = setup([parent, a, b]);
  const runs = [run('focus-task-a', a.id), run('focus-task-b', b.id)].map(item => ({ ...item, parentChatId: parent.id,
    completionPolicy: { ...item.completionPolicy!, kind: 'wake_delegator' as const, version: 1 as const, recipientChatId: parent.id, subscriptionId: item.runId, cancellationEpoch: 0 } }));
  parent.history = [{ role: 'user', content: 'Investigate with two agents.' }, { role: 'assistant', content: 'The parent answer stays readable.' }];
  parent.subAgentRuns = runs.map(item => ({ ...item, parentTurnId: item.parentTurnId! }));
  renderChatFromHistory(parent);
  const oldGroup = area.querySelector<HTMLDetailsElement>('.sub-agent-group')!; assert.ok(oldGroup);
  oldGroup.open = false; oldGroup.dispatchEvent(new win!.Event('toggle')); oldGroup.querySelector<HTMLElement>('summary')!.focus();
  renderChatFromHistory(parent);
  const group = area.querySelector<HTMLDetailsElement>('.sub-agent-group')!;
  assert.equal(group.open, false); assert.equal(document.activeElement, group.querySelector('summary'));
  assert.equal(group.classList.contains('chat-work-hidden'), false);
});

test('child header uses the common mount, current parent titles, capped ancestry and captured authority without a second transcript', () => {
  const root = shell('parent'), chain = [root, ...Array.from({ length: 7 }, (_, i) => shell(`ancestor-${i}`, i ? `ancestor-${i - 1}` : root.id))];
  const child = chain.at(-1)!; const area = setup(chain, child.id);
  child.agentAuthority = { modeId: 'plan', fileWriteScope: 'plans', filesystemAccess: 'workspace', shellSandboxMode: 'restricted', toolPermissions: { read_file: 'full', save_file: 'off' } };
  syncAgentConversationHeader(child, area);
  const header = area.querySelector<HTMLElement>('.agent-chat-context')!;
  assert.match(header.textContent!, /Subagent of ancestor-5/); assert.match(header.textContent!, /Inherited ceiling: plan/);
  assert.match(header.textContent!, /1 tools available/); assert.match(header.textContent!, /Queued messages keep their saved model/);
  assert.ok(header.querySelector('nav')!.textContent!.includes('…'));
  assert.ok(header.querySelectorAll('nav a').length <= 4);
  chain.at(-2)!.name = 'Renamed parent'; syncAgentConversationHeader(child, area);
  assert.equal(area.querySelector('.agent-chat-context'), header); assert.match(header.textContent!, /Renamed parent/);
  renderChatFromHistory(child);
  assert.equal(area.querySelectorAll('.agent-chat-context').length, 1); assert.equal(area.querySelectorAll('.chat-app-empty, #emptyState').length, 0);
});

test('typed peer text matching old hidden prefixes stays visible with current sender link and stable disclosure', () => {
  const source = shell('source'), target = shell('target'); source.name = 'Build investigation'; const area = setup([source, target], target.id);
  const message: UserMessage = { role: 'user', content: '[Sub-agent finished] This is an actual peer message.', createdAt: 1780000000000, messageId: 'peer-row', commandId: 'peer-command',
    provenance: { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message', sourceChatId: source.id, commandId: 'peer-command' } };
  assert.equal(isHiddenTranscriptUserMessage(message), false);
  assert.equal(isHiddenTranscriptUserMessage({ role: 'user', content: message.content }), true, 'legacy hidden delivery remains hidden');
  const row = createAttributedAgentMessage(target, message, 0); area.append(row);
  assert.match(row.querySelector('summary')!.textContent!, /Message from Build investigation/);
  assert.match(row.querySelector('summary')!.textContent!, /Received/);
  assert.equal(row.querySelector('time')!.getAttribute('datetime'), new Date(message.createdAt!).toISOString());
  assert.equal(row.querySelector('a')!.getAttribute('href'), '#/app/code/chat?chatId=source');
  row.open = true; row.dispatchEvent(new win!.Event('toggle'));
  source.name = 'Current source title'; const restored = createAttributedAgentMessage(target, message, 0);
  assert.equal((restored as HTMLDetailsElement).open, true); assert.match(restored.textContent!, /Current source title/);
  assert.equal(restored.classList.contains('user'), false); assert.equal(restored.querySelector('.msg-label')?.textContent, undefined);
});

test('published results use their own attributed event and normal assistant turn boundaries instead of human bubbles', () => {
  const parent = shell('parent'), child = shell('result-child', parent.id); const area = setup([parent, child]);
  const result: UserMessage = { role: 'user', content: '[Sub-agent finished]\nThe original result.', messageId: 'result-row',
    provenance: { version: 1, actor: 'system', source: 'task_delivery', kind: 'delegation_result', runId: 'result-task', commandId: 'result-command' } };
  parent.history = [result, { role: 'assistant', content: 'The final answer.' }];
  assert.equal(collectTranscriptTurns(parent)[0]!.fork, 0);
  renderChatFromHistory(parent);
  const row = area.querySelector('.agent-message--result')!;
  assert.ok(row); assert.match(row.textContent!, /Agent results/); assert.match(row.textContent!, /Published result/);
  assert.equal(area.querySelectorAll('.msg.user').length, 0); assert.ok(area.textContent!.includes('The final answer.'));
});

test('failed prompt-driven delegation remains an inline error without manufacturing a child activity card', () => {
  const parent = shell('preflight-parent'); const area = setup([parent]);
  parent.history = [{ role: 'user', content: 'Use the unavailable model for a reviewer.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'invalid-spawn', type: 'function', function: { name: 'spawn_sub_agent', arguments: '{"type":"explore","task":"Inspect","target":{"providerId":"provider","modelId":"missing"}}' } }] },
    { role: 'tool', tool_call_id: 'invalid-spawn', content: 'Error: The selected model is unavailable. No agent conversation was created.' },
    { role: 'assistant', content: 'The requested reviewer model is unavailable.' }];
  renderChatFromHistory(parent);
  const failed = area.querySelector<HTMLElement>('.tool-call-msg--fail[data-tool-name="spawn_sub_agent"]')!; assert.ok(failed);
  const container = failed.closest('.tool-call-batch') ?? failed;
  assert.equal(container.classList.contains('chat-work-hidden'), false);
  assert.equal(area.querySelectorAll('.sub-agent-card').length, 0);
});

test('live persistent cards show the activity line, a running clock and the files the agent changed', () => {
  const parent = shell('parent'), child = shell('child-files', parent.id); const area = setup([parent, child]);
  const live = { ...run('files-task', child.id), startedAt: new Date(Date.now() - 65_000).toISOString(), liveCurrentToolName: 'save_file',
    messages: [
      { role: 'tool', tool_call_id: 'a', content: 'ok', codeChange: { additions: 54, deletions: 0, path: 'src/world.js' } },
      { role: 'tool', tool_call_id: 'b', content: 'ok', codeChange: { additions: 22, deletions: 3, path: 'src/ui.js' } },
    ] } as SubAgentRun;
  const row = upsertPersistentAgentActivity(live, parent.id, area)!;
  const activity = row.querySelector<HTMLElement>('.sub-agent-card__activity')!;
  assert.equal(activity.hidden, false); assert.ok(activity.classList.contains('agent-shimmer'));
  assert.match(activity.textContent!, /Calling/);
  assert.match(row.querySelector('.sub-agent-card__clock')!.textContent!, /1m/);
  const chips = [...row.querySelectorAll<HTMLElement>('.sub-agent-card__file')];
  assert.deepEqual(chips.map(chip => chip.textContent), ['world.js+54', 'ui.js+22−3']);
  assert.equal(chips[0]!.title, 'src/world.js');

  const settled = { ...live, status: 'completed' as const, endedAt: new Date(Date.parse(live.startedAt!) + 41_000).toISOString(), summary: 'Built both modules.' };
  upsertPersistentAgentActivity(settled, parent.id, area);
  assert.equal(activity.hidden, true);
  assert.equal(row.querySelector('.sub-agent-card__clock')!.textContent, '41s');
  assert.equal(row.querySelectorAll('.sub-agent-card__file').length, 2, 'settled cards keep their own files');
});

test('file chips cap at three with an overflow count, and fall back to the child line totals', () => {
  const parent = shell('parent'), child = shell('child-many', parent.id); const area = setup([parent, child]);
  const messages = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((path, i) => ({ role: 'tool', tool_call_id: path, content: 'ok', codeChange: { additions: 10 - i, deletions: 0, path } }));
  const row = upsertPersistentAgentActivity({ ...run('many-files', child.id), messages } as SubAgentRun, parent.id, area)!;
  const chips = [...row.querySelectorAll<HTMLElement>('.sub-agent-card__file')];
  assert.equal(chips.length, 4); assert.equal(chips[3]!.textContent, '+2 more');

  const other = shell('child-totals', parent.id); other.codeChangeTotals = { additions: 148, deletions: 0 };
  setSessionStateForTests({ ...defaultSessionState(), chats: [parent, child, other], activeId: parent.id });
  const totalsRow = upsertPersistentAgentActivity(run('totals-only', other.id, 'other-turn'), parent.id, area)!;
  assert.deepEqual([...totalsRow.querySelectorAll('.sub-agent-card__file')].map(chip => chip.textContent), ['+148']);
});
