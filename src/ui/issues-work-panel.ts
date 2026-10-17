import type { Chat, IssueCard } from '../types';
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import { registerIssueChatHost, subscribeIssueChatQuestions } from '../chat/issue-chat-host';
import { linkedIssueChats, issueWorkChat, issueAgentCaption, issueDelivery } from '../issues/work-state';
import { isClosedStatus, statusIdForRole } from '../issues/taxonomy';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { appendIssueActivity, appendIssueLinks, findIssueById, updateIssue } from '../state/issues-store';
import { ensureChatHistoryLoaded, findChatById, scheduleSaveSessions, sessionState, touchChat } from '../state/sessions';
import { worktreePathsEqual } from '../lib/worktree-list-parse';
import { resetRegisteredWorktreePathCache } from '../lib/worktree-allowlist-client';
import { issueWorkOperation, type IssueWorkRequest, type IssueWorkSnapshot } from '../state/git-api';
import { getChatRunActivity, subscribeChatRunActivity } from '../state/chat-run-activity';
import { isChatStreaming, readChatStreamText, subscribeChatStreamActivity, subscribeChatStreamEnd } from '../chat/streaming-state';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { createIcon } from './icon';
import { createDetailTextButton } from './issues-detail-section';
import '../styles/issues-work.css';

export type IssueWorkspaceTab = 'Issue' | 'Work' | 'Chat' | 'Activity';
interface MountOptions {
  panel: HTMLElement;
  sticky: HTMLElement;
  document: HTMLElement;
  issueBody: HTMLElement;
  issue: IssueCard;
  tab: IssueWorkspaceTab;
  onTab: (tab: IssueWorkspaceTab) => void;
  onStartChat: () => void;
}

const operations = new Set<string>();
const commitDrafts = new Map<string, string>();
const replyDrafts = new Map<string, string>();
let mountSequence = 0;
const text = (tag: string, value: string, className = ''): HTMLElement => {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
};
function messageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => part && typeof part === 'object' && 'text' in part ? String(part.text ?? '') : '').filter(Boolean).join('\n');
}

/** Tabs wrap the existing editor and property rail; none of its features are replaced. */
export function mountIssueWorkspace(options: MountOptions): { dispose: () => void; select: (tab: IssueWorkspaceTab) => void } {
  const { panel, sticky, document: issueDocument, issueBody } = options;
  const id = options.issue.id;
  const key = `issue-workspace-${++mountSequence}`;
  let disposed = false;
  let tab = options.tab;
  let selectedChat = issueWorkChat(options.issue)?.id;
  let reviewed: IssueWorkSnapshot | undefined;
  let inspectedPath = '';
  let loading = false;
  let generation = 0;
  let error = '';
  let confirming = false;
  let cleanup = false;
  const current = () => findIssueById(id) ?? options.issue;
  const chat = () => (selectedChat ? findChatById(selectedChat) : undefined) ?? issueWorkChat(current());
  const busy = () => operations.has(id);
  const sourceRunning = () => (sessionState?.chats ?? []).some((entry) => {
    const source = entry.worktreeRoot || entry.workspacePath;
    return source && worktreePathsEqual(source, chat()?.worktreeRoot || current().workspacePath) && getChatRunActivity(entry.id, entry) === 'running';
  });

  const summary = document.createElement('section');
  summary.className = 'issues-work-summary';
  summary.setAttribute('aria-label', 'Agent work');
  issueDocument.prepend(summary);
  const tablist = document.createElement('div');
  tablist.className = 'issues-work-tabs';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Issue detail');
  const content = document.createElement('div');
  content.className = 'issues-detail__scroll issues-work-content';
  const footer = document.createElement('footer');
  footer.className = 'issues-work-footer';
  const transcript = document.createElement('div');
  const questions = document.createElement('div');
  questions.className = 'issues-work-questions';
  let unregisterQuestions = () => {};
  const live = document.createElement('div');
  live.className = 'issues-work-chat__live';
  const composer = document.createElement('form');
  composer.className = 'issues-work-chat__composer';
  const reply = document.createElement('textarea');
  reply.setAttribute('aria-label', 'Message the issue chat');
  reply.placeholder = 'Ask about the work or request changes…';
  reply.value = replyDrafts.get(id) ?? '';
  reply.rows = 3;
  reply.addEventListener('input', () => replyDrafts.set(id, reply.value));
  const replyActions = document.createElement('div');
  replyActions.className = 'issues-work-actions';
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'issues-btn issues-btn--primary';
  send.textContent = 'Send';
  replyActions.append(send);
  composer.append(reply, replyActions);

  function action(label: string, icon: 'appChat' | 'gitMerge' | 'gitCommit' | 'refresh' | 'arrowUp' | 'close' | 'gitWorktree', handler: () => void, primary = false, disabled = false): HTMLButtonElement {
    return createDetailTextButton({ label, icon, onClick: handler, primary, disabled });
  }
  function request(): IssueWorkRequest {
    const issue = current();
    const linked = chat();
    return { cwd: issue.workspacePath, worktreePath: linked?.worktreeRoot || issue.workspacePath, sourceHead: reviewed?.sourceHead, targetHead: reviewed?.targetHead, sourceBranch: reviewed?.sourceBranch, targetBranch: reviewed?.targetBranch, fingerprint: reviewed?.fingerprint };
  }
  function paintSummary(): void {
    const issue = current();
    const state = issueAgentCaption(issue);
    summary.hidden = !chat() && !issue.agent && !issueDelivery(issue);
    summary.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'issues-work-summary__heading';
    heading.append(createIcon('appAgentActivity', { size: 14 }), text('strong', state.text));
    heading.append(action('View work', 'arrowUp', () => select('Work')));
    summary.append(heading);
    const caption = state.status === 'running' ? 'Agent activity is live. Completed implementation turns return to Review.'
      : state.status === 'completed' ? 'Agent turn completed. Review the changes and verification in the linked chat.'
      : 'The linked chat, worktree, and delivery record stay with this issue.';
    summary.append(text('p', caption));
    if (chat()?.worktreeRoot) summary.append(text('div', chat()!.worktreeRoot!, 'issues-work-path'));
  }
  function paintError(host: HTMLElement): void {
    if (error) {
      const note = text('p', error, 'issues-work-error');
      note.setAttribute('role', 'alert');
      host.append(note);
    }
  }
  async function inspect(): Promise<void> {
    const token = ++generation;
    loading = true;
    error = '';
    paintWork();
    const result = await issueWorkOperation('Inspect', request());
    if (disposed || token !== generation) return;
    loading = false;
    reviewed = result.ok ? result : undefined;
    inspectedPath = request().worktreePath ?? '';
    if (!result.ok) error = result.error || 'Could not load the issue worktree';
    paintWork();
    paintFooter();
  }
  function recordDelivery(result: IssueWorkSnapshot, operationInput: IssueWorkRequest, chatId: string): void {
    const issue = current();
    if (!result.merged) return;
    if (result.worktreeRemoved) detachLinkedChats(operationInput.worktreePath || '');
    appendIssueLinks(id, { gitLinks: [{ kind: 'commit', ref: result.sha!, title: `[${id}] ${issue.title}` }] });
    appendIssueActivity(id, { kind: 'work-merged', actorKind: 'user', data: {
      chatId, sha: result.sha || '', mergeSha: result.mergeSha || '', sourceBranch: result.sourceBranch || '', targetBranch: result.targetBranch || '', worktreePath: operationInput.worktreePath || '',
      worktreeRemoved: Boolean(result.worktreeRemoved), branchRemoved: Boolean(result.branchRemoved), cleanupRequested: cleanup, cleanupError: result.cleanupError || '',
    } });
    const done = statusIdForRole(getIssuesTaxonomySync(), 'done');
    if (done) updateIssue(id, { status: done });
  }
  function detachLinkedChats(path: string): void {
    resetRegisteredWorktreePathCache();
    for (const linked of sessionState?.chats ?? []) {
      if (!linked.worktreeRoot || !worktreePathsEqual(linked.worktreeRoot, path)) continue;
      delete linked.worktreeRoot;
      delete linked.chatWorktreeManaged;
      delete linked.gitBranch;
      touchChat(linked);
    }
    scheduleSaveSessions();
  }
  async function perform(kind: 'Commit' | 'Merge'): Promise<void> {
    if (busy() || !reviewed?.ok || sourceRunning()) return;
    const operationChatId = chat()?.id || '';
    const input = { ...request(), message: commitDrafts.get(id) ?? `[${id}] ${current().title}`, cleanup };
    if (reviewed.dirty && !input.message.trim()) { error = 'Enter a commit message'; paintFooter(); return; }
    operations.add(id);
    error = '';
    paintFooter();
    const result = await issueWorkOperation(kind, input);
    operations.delete(id);
    if (result.ok && kind === 'Merge') recordDelivery(result, input, operationChatId);
    if (result.ok && kind === 'Commit' && result.sha) {
      appendIssueLinks(id, { gitLinks: [{ kind: 'commit', ref: result.sha, title: input.message }] });
      appendIssueActivity(id, { kind: 'work-committed', actorKind: 'user', data: { sha: result.sha, chatId: operationChatId } });
    }
    confirming = false;
    if (disposed) return;
    if (!result.ok) error = result.error || `${kind} failed. The worktree is preserved.`;
    else if (result.cleanupError) error = `Merged successfully. Cleanup needs attention: ${result.cleanupError}`;
    reviewed = undefined;
    paintSummary();
    if (result.merged) { paintWork(); paintFooter(); }
    else {
      const message = error;
      await inspect();
      if (!disposed && message) { error = message; paintWork(); paintFooter(); }
    }
  }
  async function retryCleanup(): Promise<void> {
    const delivery = issueDelivery(current());
    const data = delivery?.data;
    if (!data || busy() || sourceRunning()) return;
    operations.add(id);
    paintFooter();
    const result = await issueWorkOperation('Cleanup', { cwd: current().workspacePath, worktreePath: String(data.worktreePath), sourceBranch: String(data.sourceBranch), sha: String(data.sha) });
    operations.delete(id);
    if (result.ok && result.worktreeRemoved) {
      detachLinkedChats(String(data.worktreePath));
      appendIssueActivity(id, { kind: 'work-merged', actorKind: 'user', data: { ...data, worktreeRemoved: true, branchRemoved: Boolean(result.branchRemoved), cleanupError: result.cleanupError || '' } });
    }
    error = result.error || result.cleanupError || '';
    if (!disposed) { paintWork(); paintFooter(); }
  }
  function paintWork(): void {
    if (tab !== 'Work') return;
    content.replaceChildren();
    const delivery = issueDelivery(current());
    const linked = chat();
    if (delivery && (!linked || delivery.data?.chatId === linked.id) && !linked?.worktreeRoot) {
      content.append(text('h3', 'Merged into ' + String(delivery.data?.targetBranch || 'the workspace')));
      content.append(text('p', `Commit ${String(delivery.data?.sha || '').slice(0, 12)}`));
      content.append(text('p', delivery.data?.worktreeRemoved ? 'Worktree removed. The linked chat and merge history are retained.' : 'The worktree was kept.'));
      paintError(content);
      return;
    }
    const heading = document.createElement('div');
    heading.className = 'issues-work-actions';
    heading.append(text('h3', 'Changes'), action(loading ? 'Refreshing…' : 'Refresh', 'refresh', () => void inspect(), false, loading || busy()));
    content.append(heading);
    if (loading) { content.append(text('p', 'Reading the worktree and destination branch…', 'issues-work-note')); return; }
    paintError(content);
    if (!reviewed) { content.append(text('p', 'Start a linked chat or refresh to inspect workspace changes.', 'issues-work-note')); return; }
    content.append(text('p', `${reviewed.sourceBranch} → ${reviewed.targetBranch}${reviewed.isolated ? '' : ' · local workspace'}`, 'issues-work-path'));
    if (reviewed.sourceBranch === 'HEAD' || reviewed.targetBranch === 'HEAD') content.append(text('p', 'Detached HEAD: check out a branch in Source Control before committing or merging.', 'issues-work-note'));
    content.append(text('p', `${reviewed.files?.length || 0} changed files · ${reviewed.ahead || 0} unmerged commits${reviewed.dirty ? ' · uncommitted changes' : ''}`));
    if (reviewed.conflict) content.append(text('p', `Merge conflict: ${(reviewed.conflictedFiles || []).join(', ')}. Resolve with the agent before merging.`, 'issues-work-error'));
    content.append(text('p', 'Verification results are in the linked Chat. Turn completion does not certify that tests passed.', 'issues-work-note'));
    for (const file of reviewed.files || []) content.append(text('div', file, 'issues-work-file'));
    if (reviewed.patch) {
      const details = document.createElement('details');
      details.open = true;
      details.append(text('summary', 'Review diff'));
      const pre = document.createElement('pre');
      for (const line of reviewed.patch.split('\n')) pre.append(text('span', line + '\n', line.startsWith('+') ? 'issues-work-diff-add' : line.startsWith('-') ? 'issues-work-diff-remove' : ''));
      details.append(pre);
      content.append(details);
    }
    if (reviewed.truncated) content.append(text('p', 'Diff truncated at 512 KB. Open Code to inspect the remaining changes.', 'issues-work-note'));
  }
  async function paintChat(): Promise<void> {
    const linked = chat();
    content.replaceChildren();
    const picker = document.createElement('select');
    picker.className = 'issues-filter';
    picker.setAttribute('aria-label', 'Linked issue chat');
    for (const entry of linkedIssueChats(current())) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.name || entry.id;
      option.selected = entry.id === linked?.id;
      picker.append(option);
    }
    picker.addEventListener('change', () => { selectedChat = picker.value; reviewed = undefined; generation++; loading = false; void paintChat(); paintFooter(); });
    const tools = document.createElement('div');
    tools.className = 'issues-work-actions';
    if (linked) tools.append(picker, action('Open in Code', 'appChat', () => {
      void import('../os/code-window-command').then(async ({ routeCodeWindowCommand }) => {
        if (await routeCodeWindowCommand({ kind: 'chat', chatId: linked.id, workspacePath: current().workspacePath })) return;
        const { launchCodeWithChat } = await import('../os/chat-launch');
        await launchCodeWithChat(linked.id);
      });
    }));
    else tools.append(text('p', 'No chat attached yet.'), action('Send to chat', 'appChat', options.onStartChat, true));
    unregisterQuestions();
    content.append(tools, transcript, live, questions);
    if (linked) unregisterQuestions = registerIssueChatHost(linked.id, questions);
    queueMicrotask(notifyAskQuestionDisplayContextChanged);
    if (!linked) { transcript.replaceChildren(); return; }
    await ensureChatHistoryLoaded(linked.id);
    if (disposed || tab !== 'Chat' || chat()?.id !== linked.id) return;
    paintTranscript(linked);
    if (!isClosedStatus(getIssuesTaxonomySync(), current().status)) content.append(composer);
    send.disabled = isChatStreaming(linked.id) || busy();
    paintLive();
  }
  function paintTranscript(linked: Chat): void {
    transcript.replaceChildren();
    for (const message of linked.history.slice(-60)) {
      if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') continue;
      const body = messageText(message.content);
      const calls = 'tool_calls' in message ? message.tool_calls : undefined;
      if (!body && !calls?.length) continue;
      const entry = document.createElement(message.role === 'tool' ? 'details' : 'section');
      entry.className = 'issues-work-message';
      const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'Tool result';
      entry.append(text(message.role === 'tool' ? 'summary' : 'h3', label));
      const prose = document.createElement('div');
      if (message.role === 'assistant') setAssistantBubbleContent(prose, body);
      else prose.textContent = message.role === 'user' && message.issue ? `${message.issue.id}: ${message.issue.title}` : body;
      entry.append(prose);
      if (calls?.length) entry.append(text('p', calls.map((tool) => tool.function.name).join(' · '), 'issues-work-note'));
      transcript.append(entry);
    }
  }
  function paintLive(): void {
    if (tab !== 'Chat') return;
    const linked = chat();
    const stream = linked ? readChatStreamText(linked.id) : null;
    live.textContent = stream?.lastDelta || (linked && isChatStreaming(linked.id) ? `Working${stream ? ` · ${stream.toolCallCount} tool calls` : ''}…` : '');
    send.disabled = Boolean(linked && isChatStreaming(linked.id)) || busy();
  }
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const linked = chat();
    const value = reply.value.trim();
    if (!linked || !value || isChatStreaming(linked.id) || busy()) return;
    reply.value = '';
    replyDrafts.delete(id);
    appendIssueActivity(id, { kind: 'chat-started', actorKind: 'user', data: { chatId: linked.id, modeId: linked.modeId || 'general' } });
    if (linked.modeId === 'build' || linked.modeId === 'debug') {
      const active = statusIdForRole(getIssuesTaxonomySync(), 'in_progress');
      if (active) updateIssue(id, { status: active });
    }
    void import('../chat/messaging').then(({ sendProgrammaticChatText }) => sendProgrammaticChatText(linked, value, { ownsGlobalStreaming: false, requireCompletedTurn: true })).catch((reason: unknown) => {
      replyDrafts.set(id, value);
      if (!disposed) { reply.value = value; error = reason instanceof Error ? reason.message : String(reason); paintFooter(); }
    });
  });
  function paintActivity(): void {
    content.replaceChildren(text('h3', 'Activity'));
    for (const entry of [...(current().activity ?? [])].reverse()) {
      const row = document.createElement('div');
      row.className = 'issues-work-event';
      row.append(text('strong', entry.kind.replace(/-/g, ' ')), text('time', new Date(entry.at).toLocaleString(), 'issues-work-note'));
      if (entry.data) row.append(text('p', Object.entries(entry.data).map(([name, value]) => `${name}: ${value}`).join(' · ')));
      content.append(row);
    }
    if (!current().activity?.length) content.append(text('p', 'No recorded work events yet.', 'issues-work-note'));
  }
  function paintFooter(): void {
    footer.replaceChildren();
    const issue = current();
    const linked = chat();
    const delivery = issueDelivery(issue);
    const row = document.createElement('div');
    row.className = 'issues-work-actions';
    footer.append(row);
    paintError(footer);
    if (delivery && delivery.data?.chatId === linked?.id) {
      row.append(text('strong', `Merged to ${String(delivery.data?.targetBranch || 'workspace')}`));
      if (delivery.data?.cleanupRequested && (!delivery.data?.worktreeRemoved || !delivery.data?.branchRemoved)) row.append(action('Retry cleanup', 'gitWorktree', () => void retryCleanup(), false, busy()));
      if (delivery.data?.cleanupError) footer.append(text('p', String(delivery.data.cleanupError), 'issues-work-error'));
      if (!linked?.worktreeRoot) return;
    }
    if (!linked) { row.append(text('span', 'Send this issue to chat to start work.', 'issues-work-note')); return; }
    if (sourceRunning()) {
      row.append(text('span', 'A chat is working in this checkout. Wait for it to finish before delivering changes.', 'issues-work-note'));
      if (getChatRunActivity(linked.id, linked) === 'running') row.append(action('Stop', 'close', () => { void import('../chat/stop-generation').then((m) => m.stopGeneration(linked.id)); }));
      return;
    }
    if (busy()) { row.append(text('span', 'Applying reviewed work…', 'issues-work-note')); return; }
    if (!reviewed?.ok) { row.append(action('Review work', 'gitWorktree', () => select('Work'))); return; }
    row.append(text('span', `${reviewed.sourceBranch} → ${reviewed.targetBranch}`, 'issues-work-path'));
    if (!confirming) {
      row.append(action('Refresh', 'refresh', () => void inspect(), false, loading));
      if (reviewed.dirty) row.append(action('Commit', 'gitCommit', () => { confirming = true; select('Work'); paintFooter(); }, false, reviewed.sourceBranch === 'HEAD'));
      if (reviewed.isolated) row.append(action(reviewed.dirty ? 'Commit & merge' : 'Merge', 'gitMerge', () => { confirming = true; select('Work'); paintFooter(); }, true, loading || reviewed.sourceBranch === 'HEAD' || reviewed.targetBranch === 'HEAD' || Boolean(reviewed.conflict) || !reviewed.dirty && !reviewed.ahead));
      if (reviewed.conflict) row.append(action('Resolve in chat', 'appChat', () => { select('Chat'); reply.value = `Resolve the merge conflicts with ${reviewed?.targetBranch} in this issue worktree, rerun verification, and return the work for review. Do not merge or remove the worktree.`; replyDrafts.set(id, reply.value); reply.focus(); }));
      return;
    }
    const label = document.createElement('label');
    label.className = 'issues-work-field';
    label.append(text('span', 'Commit message'));
    const input = document.createElement('input');
    input.value = commitDrafts.get(id) ?? `[${id}] ${issue.title}`;
    input.addEventListener('input', () => commitDrafts.set(id, input.value));
    label.append(input);
    if (reviewed.dirty) footer.append(label, text('p', 'Commits all changes listed in this checkout, including staged and untracked files.', 'issues-work-note'));
    const choices = document.createElement('div');
    choices.className = 'issues-work-actions';
    if (reviewed.isolated) {
      const cleanupLabel = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = cleanup;
      checkbox.addEventListener('change', () => { cleanup = checkbox.checked; });
      cleanupLabel.append(checkbox, text('span', 'Remove worktree and branch after merge'));
      choices.append(cleanupLabel);
    }
    footer.append(choices);
    const confirm = document.createElement('div');
    confirm.className = 'issues-work-actions';
    confirm.append(action('Cancel', 'close', () => { confirming = false; paintFooter(); }));
    if (reviewed.dirty) confirm.append(action('Commit only', 'gitCommit', () => void perform('Commit')));
    if (reviewed.isolated) confirm.append(action(`Merge into ${reviewed.targetBranch}`, 'gitMerge', () => void perform('Merge'), true));
    footer.append(confirm);
  }
  function select(next: IssueWorkspaceTab): void {
    if (next !== 'Chat') { unregisterQuestions(); unregisterQuestions = () => {}; }
    tab = next;
    options.onTab(next);
    issueBody.hidden = next !== 'Issue';
    content.hidden = next === 'Issue';
    for (const button of tablist.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === next));
      button.tabIndex = button.dataset.tab === next ? 0 : -1;
    }
    issueBody.setAttribute('aria-labelledby', `${key}-Issue`);
    content.setAttribute('aria-labelledby', `${key}-${next}`);
    if (next === 'Work') { paintWork(); if (!loading && (!reviewed || inspectedPath !== request().worktreePath)) void inspect(); }
    else if (next === 'Chat') void paintChat();
    else if (next === 'Activity') paintActivity();
    paintFooter();
    queueMicrotask(notifyAskQuestionDisplayContextChanged);
  }
  for (const name of ['Issue', 'Work', 'Chat', 'Activity'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${key}-${name}`;
    button.dataset.tab = name;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', name === 'Issue' ? `${key}-issue` : `${key}-work`);
    button.textContent = name;
    button.addEventListener('click', () => select(name));
    tablist.append(button);
  }
  tablist.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...tablist.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
    select(buttons[next].dataset.tab as IssueWorkspaceTab);
  });
  issueBody.id = `${key}-issue`;
  content.id = `${key}-work`;
  issueBody.setAttribute('role', 'tabpanel');
  content.setAttribute('role', 'tabpanel');
  sticky.append(tablist);
  panel.append(content, footer);
  const unsubscribe = subscribeChatRunActivity(() => {
    if (disposed) return;
    paintSummary();
    if (tab === 'Chat' && chat()) { paintTranscript(chat()!); paintLive(); }
    if (tab === 'Work' && !isChatStreaming(chat()?.id ?? '')) { reviewed = undefined; void inspect(); }
    paintFooter();
  });
  const unsubscribeStream = subscribeChatStreamActivity((chatId) => { if (chatId === chat()?.id) paintLive(); });
  const unsubscribeQuestions = subscribeIssueChatQuestions(paintSummary);
  const unsubscribeEnd = subscribeChatStreamEnd((chatId) => {
    if (chatId !== chat()?.id) return;
    queueMicrotask(() => {
      if (disposed) return;
      paintSummary();
      if (tab === 'Chat' && chat()) { paintTranscript(chat()!); paintLive(); }
      if (tab === 'Work') { reviewed = undefined; void inspect(); }
      paintFooter();
    });
  });
  cleanup = chat()?.chatWorktreeManaged === true;
  paintSummary();
  select(tab);
  return { select, dispose: () => { disposed = true; generation++; replyDrafts.set(id, reply.value); unregisterQuestions(); queueMicrotask(notifyAskQuestionDisplayContextChanged); unsubscribe(); unsubscribeStream(); unsubscribeEnd(); unsubscribeQuestions(); } };
}
