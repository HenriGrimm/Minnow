import { mountIssuePlanPreview } from '../ui/issues-plan-preview';
import type { SavedIssuePlan } from '../issues/saved-plan';
import { mountSharedChatHost } from '../ui/shared-chat-host';
import type { Chat, IssueCard, TerminalRunRecord } from '../types';
import { sessionState } from '../state/sessions';
import { findIssueById } from '../state/issues-store';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import type { IssueWorkSnapshot } from '../state/git-api';
import { launchApp } from '../os/router';
import { listMainTurnActivity } from '../chat/main-turn-activity';
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { isChatStreaming, subscribeChatStreamActivity, subscribeChatStreamEnd } from '../chat/streaming-state';
import { createIcon } from '../ui/icon';
import { blockers, issueChat } from './flow-model';
import { approveHomeIssue, approveHomePlan, pauseHomeIssue, replyHomeIssue } from './flow-actions';
import { button, el } from './dom';
import { updateHomeStatus } from './status-chip';
import { createHomeIssueStatus, updateHomeIssueStatus } from './issue-status';
import { mountWorkChanges } from './work-changes';
import { mountRunEvidence } from './run-evidence';
import { mountHomeTerminal } from './command-console';

export { mountHomeTerminal } from './command-console';
type DockView = 'conversation' | 'changes' | 'runs';
interface DockMemory { draft: string; view: DockView; sideChat: boolean; scroll: number; brief: boolean; mode: 'build' | 'plan'; expanded: Set<number>; chatId?: string }
const memories = new Map<string, DockMemory>();

export interface DockOptions {
  issue: IssueCard; issues: IssueCard[]; workspace: string; modelLabel: string;
  start: (issue: IssueCard, mode: 'build' | 'plan', instructions: string) => void;
  select: (issue: IssueCard) => void;
  addToChat: (issue: IssueCard, chat: Chat) => void;
  currentIssues?: () => IssueCard[];
  collapse?: () => void;
  close?: () => void;
  maximize?: () => void;
  isMaximized?: () => boolean;
}

/** Selected issue, conversation and review share one persistent, scoped workspace. */
export function mountIssueDock(host: HTMLElement, options: DockOptions): { update: () => void; dispose: () => void } {
  let { issue } = options;
  const chat = issueChat(issue, sessionState?.chats ?? []);
  const memoryKey = JSON.stringify([options.workspace, issue.id]);
  const memory: DockMemory = memories.get(memoryKey) ?? { draft: '', view: issue.agent?.home?.state === 'ready' ? 'changes' : 'conversation', sideChat: true, scroll: 0, brief: issue.agent?.home?.state === 'planned', mode: 'build', expanded: new Set<number>() };
  // Pre-start instructions are already in the first user message once a chat is attached.
  if (chat && !memory.chatId) { memory.draft = ''; memory.chatId = chat.id; }
  memories.set(memoryKey, memory);
  let disposed = false, busy = false;
  let sharedChat: ReturnType<typeof mountSharedChatHost> | undefined;
  let snapshot: IssueWorkSnapshot | undefined, runs: TerminalRunRecord[] = [], runSignature = '';
  let lastQuestion = false, lastAgentError = '';
  const tabButtons = new Map<DockView, HTMLButtonElement>();
  const checkout = () => chat?.worktreeRoot || issue.agent?.worktreePath || options.workspace;
  const target = () => issue.agent?.home?.baseBranch;
  const openCode = () => launchApp('code', chat ? { chatId: chat.id } : {});
  const shell = el('div', '', 'home-workspace'); shell.classList.toggle('home-workspace--start', !chat); shell.setAttribute('aria-label', 'Issue workspace');
  const header = el('header', '', 'home-workspace-header');
  const title = el('h2', issue.title); title.id = 'home-dock-title';
  const status = el('span', '', 'home-status'); status.setAttribute('role', 'status');
  const issueStatus = createHomeIssueStatus(issue);
  const chrome = el('div', '', 'home-workspace-chrome');
  const maximize = button('Maximize details', () => options.maximize?.(), false, 'expand'); maximize.setAttribute('aria-label', 'Maximize details');
  const collapse = button('Collapse details', () => options.collapse?.(), false, 'minimize'); collapse.setAttribute('aria-label', 'Collapse details');
  const close = button('Close details', () => options.close?.(), false, 'close'); close.setAttribute('aria-label', 'Close details');
  if (options.maximize) chrome.append(maximize); if (options.collapse) chrome.append(collapse); if (options.close) chrome.append(close);
  header.append(el('span', issue.id, 'home-mono home-muted'), title, issueStatus, status, chrome);
  const navigation = el('div', '', 'home-workspace-navigation');
  const tablist = el('div', '', 'home-dock-tablist'); tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', 'Issue workspace views');
  const scope = el('span', '', 'home-workspace-scope home-mono');
  const sideToggle = button('Show conversation', () => { if (shell.clientWidth <= 1050) selectView('conversation'); else { memory.sideChat = !memory.sideChat; selectView(memory.view); } }, false, 'comment');
  navigation.append(tablist, scope, sideToggle);
  const brief = el('aside', '', 'home-issue-brief'); brief.hidden = !memory.brief;
  brief.setAttribute('aria-label', 'Issue details');
  const briefToggle = button('Issue details', () => {
    memory.brief = !memory.brief; brief.hidden = !memory.brief;
    briefToggle.setAttribute('aria-expanded', String(memory.brief));
  }, false, 'appIssues');
  briefToggle.setAttribute('aria-expanded', String(memory.brief));
  const briefBody = el('div', '', 'home-brief-body');
  const description = () => {
    const node = el('div', '', 'home-brief-markdown');
    setAssistantBubbleContent(node, issue.description || 'No description was added.');
    return node;
  };
  const briefHeading = el('div', '', 'home-brief-heading');
  briefHeading.append(el('strong', 'Issue details'), button('Close', () => briefToggle.click(), false, 'close'));
  briefBody.append(description());
  let savedPlan: SavedIssuePlan | null = null;
  const planPreview = mountIssuePlanPreview(briefBody, plan => { savedPlan = plan; updateActions(); });
  let wasPlanned = issue.agent?.home?.state === 'planned';
  const resources = el('div', '', 'home-context-chips');
  for (const ref of issue.codeRefs ?? []) resources.append(el('span', ref.path));
  if (issue.notes) {
    const notes = el('div', '', 'home-brief-markdown');
    setAssistantBubbleContent(notes, issue.notes); briefBody.append(el('h3', 'Notes'), notes);
  }
  briefBody.append(resources, button('Open issue', () => { window.location.hash = `#/app/issues/${encodeURIComponent(issue.id)}`; }, false, 'appIssues'));
  brief.append(briefHeading, briefBody);
  navigation.append(briefToggle, button('Open in Code', openCode, false, 'externalLink'));
  const body = el('div', '', 'home-workspace-body');
  const review = el('section', '', 'home-review-work');
  const changesHost = el('div', '', 'home-changes-view'); changesHost.id = 'home-view-changes'; changesHost.setAttribute('role', 'tabpanel'); changesHost.setAttribute('aria-labelledby', 'home-tab-changes');
  const evidence = el('div', '', 'home-evidence-strip');
  const runsHost = el('div', '', 'home-runs-view'); runsHost.id = 'home-view-runs'; runsHost.setAttribute('role', 'tabpanel'); runsHost.setAttribute('aria-labelledby', 'home-tab-runs');
  const runsEvidence = el('div');
  const commandDetails = el('details', '', 'home-command-disclosure'); commandDetails.append(el('summary', 'Run a command in this checkout'));
  const terminalHost = el('div'); commandDetails.append(terminalHost); let terminalCleanup: (() => void) | undefined;
  commandDetails.ontoggle = () => { if (commandDetails.open && !terminalCleanup) terminalCleanup = mountHomeTerminal(terminalHost, checkout(), chat); };
  runsHost.append(runsEvidence, commandDetails); review.append(changesHost, evidence, runsHost);
  const conversation = el('section', '', 'home-conversation'); conversation.id = 'home-view-conversation'; conversation.setAttribute('aria-label', 'Conversation');
  const heading = el('div', '', 'home-chat-heading'); heading.append(el('strong', 'Conversation')); heading.hidden = true;
  const content = el('div', '', 'home-chat-history'); content.tabIndex = 0; content.setAttribute('role', 'log'); content.setAttribute('aria-label', 'Issue conversation');
  const latest = button('New activity ↓', () => { content.scrollTop = content.scrollHeight; latest.hidden = true; }); latest.classList.add('home-new-activity'); latest.hidden = true;
  content.onscroll = () => { memory.scroll = content.scrollTop; if (content.scrollHeight - content.scrollTop - content.clientHeight < 64) latest.hidden = true; };
  const questionHost = el('div', '', 'home-questions'); questionHost.id = 'homeFlowQuestions';
  const form = el('form', '', 'home-chat-composer');
  const input = el('textarea'); input.rows = 1; input.value = memory.draft; input.oninput = () => { memory.draft = input.value; updateActions(); };
  input.setAttribute('aria-label', chat ? 'Message to the agent' : 'Instructions before starting');
  const submit = button(chat ? 'Send message' : 'Start chat', () => form.requestSubmit(), true, chat ? 'arrowUp' : 'send'); submit.setAttribute('aria-label', chat ? 'Send message' : 'Start chat');
  const hint = el('p', '', 'home-composer-hint home-muted');
  const error = el('p', '', 'home-inline-error'); error.setAttribute('role', 'status');
  const sendRow = el('div', '', 'home-chat-input'); sendRow.append(input, submit); form.append(questionHost, sendRow, hint);
  if (!chat) {
    const waits = blockers(issue, options.issues, getIssuesTaxonomySync());
    content.append(el('span', 'READY TO START', 'home-start-eyebrow'), el('h3', issue.title), description());
    if (waits.length) content.append(el('p', `Waiting on ${waits.map(i => i.id).join(', ')}. Work is held until its blockers finish.`, 'home-blocked'));
    const controls = el('div', '', 'home-start-controls');
    const modes = el('div', '', 'home-segments'); modes.setAttribute('aria-label', 'Chat mode');
    for (const mode of ['build', 'plan'] as const) {
      const pick = button(mode === 'build' ? 'Build' : 'Plan first', () => { memory.mode = mode; for (const item of modes.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === pick)); updateActions(); }); pick.setAttribute('aria-pressed', String(memory.mode === mode)); modes.append(pick);
    }
    controls.append(modes, el('span', 'Runs in an isolated worktree', 'home-muted'), button('Add to selection', () => options.select(issue))); form.prepend(controls);
    const paths = new Set(issue.codeRefs?.map(ref => ref.path));
    const related = options.issues.find(i => i.id !== issue.id && i.agent?.chatId && i.codeRefs?.some(ref => paths.has(ref.path)));
    const relatedChat = related && issueChat(related, sessionState?.chats ?? []);
    if (relatedChat?.worktreeRoot) content.append(el('p', `“${relatedChat.name}” is already working in linked files.`, 'home-muted'), button('Add to that chat', () => options.addToChat(issue, relatedChat)));
  }
  conversation.append(heading, content, latest, form); body.append(review, conversation);
  const footer = el('footer', '', 'home-workspace-footer');
  const footerContext = el('div', '', 'home-footer-context'); const footerTitle = el('strong'), footerDetail = el('p', '', 'home-muted'); footerContext.append(footerTitle, footerDetail);
  const actions = el('div', '', 'home-review-actions');
  const request = button('Request changes', () => { memory.sideChat = true; selectView('conversation'); sharedChat?.focus(); }, false, 'comment');
  const pause = button('Pause', () => { if (issue.agent?.home?.state === 'paused') void perform(() => replyHomeIssue(issue, 'Continue from where you stopped.')); else pauseHomeIssue(issue); });
  const primary = button('Merge into main', () => {
    if (issue.agent?.home?.boardId) void perform(() => approveHomePlan(issue));
    else if (issue.agent?.home?.state === 'failed') void perform(() => replyHomeIssue(issue, chat?.modeId === 'plan' ? 'Retry the unfinished planning work. Address the last failure and finish the plan in its selected format. Stay in Plan mode.' : 'Retry the unfinished work. Address the last failure, run the relevant checks, commit the changes, and stop for review. Do not merge.'));
    else if (chat?.modeId === 'plan') void perform(() => approveHomePlan(issue));
    else if (!snapshot) { selectView('changes'); changeView.refresh(true); }
    else if (snapshot?.dirty) void perform(() => replyHomeIssue(issue, 'Review and commit the changes in this worktree, then stop for review. Do not merge.'));
    else void perform(() => approveHomeIssue(issue));
  }, true, 'gitMerge'); primary.dataset.approve = '';
  actions.append(pause, request, primary);
  const conflict = el('div', '', 'home-conflict'); conflict.hidden = true;
  conflict.append(el('p', 'The merge stopped. Inspect the changes, or ask the agent to resolve the conflict.'), button('Ask agent to resolve', () => void perform(() => replyHomeIssue(issue, `Rebase your branch onto ${target() || 'main'}. Resolve conflicts preserving both intended changes, run checks, commit, and stop for review.`)), false, 'gitRebase'), button('Resolve in Code', openCode));
  footer.append(footerContext, actions);
  const stage = el('div', '', 'home-workspace-stage'); stage.append(body, brief);
  shell.append(header, navigation, conflict, stage, error, footer); host.append(shell); host.setAttribute('aria-labelledby', title.id);

  const changeView = mountWorkChanges(changesHost, { workspace: options.workspace, checkout, target, openCode, isMerged: () => issue.agent?.home?.state === 'done', onSnapshot(value) { snapshot = value; if (!disposed) updateActions(); } });
  const runView = mountRunEvidence(runsEvidence, chat, value => { runs = value; renderEvidence(); });
  function renderEvidence(): void {
    const last = runs.at(-1); evidence.replaceChildren();
    if (!last) { evidence.append(el('span', 'No command results recorded.', 'home-muted')); return; }
    evidence.append(createIcon(last.exitCode === 0 && !last.timedOut ? 'statusPass' : 'statusFail'), el('span', last.timedOut ? 'Latest command timed out' : last.exitCode === null ? 'Latest command stopped' : `Latest command · exit ${last.exitCode}`), button('View output', () => selectView('runs')));
    evidence.append(el('span', 'Command results are not tied to a reviewed revision.', 'home-muted'));
  }
  for (const [view, label] of [['conversation', 'Conversation'], ['changes', 'Changes'], ['runs', 'Runs']] as const) {
    const tab = button(label, () => selectView(view)); tab.id = `home-tab-${view}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `home-view-${view}`);
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const views = [...tabButtons.keys()], index = views.indexOf(view);
      const next = views[event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length]; selectView(next); tabButtons.get(next)?.focus();
    };
    tabButtons.set(view, tab); tablist.append(tab);
  }
  function selectView(view: DockView): void {
    memory.view = view; shell.dataset.view = view; shell.classList.toggle('home-workspace--side-chat', memory.sideChat);
    for (const [id, tab] of tabButtons) { tab.setAttribute('aria-selected', String(id === view)); tab.tabIndex = id === view ? 0 : -1; }
    review.hidden = view === 'conversation'; changesHost.hidden = view !== 'changes'; evidence.hidden = view !== 'changes'; runsHost.hidden = view !== 'runs';
    conversation.hidden = view !== 'conversation' && !memory.sideChat;
    if (view === 'conversation') { conversation.setAttribute('role', 'tabpanel'); conversation.setAttribute('aria-labelledby', 'home-tab-conversation'); }
    else { conversation.removeAttribute('role'); conversation.removeAttribute('aria-labelledby'); }
    sideToggle.hidden = view === 'conversation' || !chat; heading.hidden = view === 'conversation'; brief.hidden = !memory.brief; sideToggle.setAttribute('aria-pressed', String(memory.sideChat)); sideToggle.querySelector('span')!.textContent = memory.sideChat ? 'Hide conversation' : 'Show conversation';
    if (view === 'changes') changeView.refresh(); if (view === 'runs') runView.refresh();
    if (chat) notifyAskQuestionDisplayContextChanged();
    queueMicrotask(() => { if (!disposed) update(); });
  }
  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy) return; busy = true; error.textContent = ''; updateActions();
    try { await action(); } catch (err) { error.textContent = err instanceof Error ? err.message : String(err); }
    finally { busy = false; if (!disposed) update(); }
  }
  form.onsubmit = event => {
    event.preventDefault(); if (submit.disabled) return;
    if (!chat) { options.start(issue, memory.mode, input.value.trim()); return; }
    const text = input.value.trim(); if (!text) return;
    input.value = memory.draft = '';
    void perform(async () => {
      try {
        await replyHomeIssue(issue, text);
        const current = findIssueById(issue.id);
        if (current?.agent?.home?.state === 'failed') throw new Error(current.agent.error || 'The agent could not complete the request. Your message has been restored.');
      }
      catch (error) { memory.draft = [text, memory.draft].filter(Boolean).join('\n\n'); input.value = memory.draft; throw error; }
    });
  };
  input.onkeydown = event => { if (chat && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } };
  function updateActions(): void {
    const state = issue.agent?.home?.state;
    const boardId = issue.agent?.home?.boardId;
    const planning = chat?.modeId === 'plan' && !boardId;
    const active = Boolean(chat && (isChatStreaming(chat.id) || listMainTurnActivity().some(turn => turn.chatId === chat.id)));
    if (active) snapshot = undefined;
    const ready = ['planned', 'ready', 'conflict'].includes(state || '');
    commandDetails.hidden = state === 'done';
    const group = (options.currentIssues?.() ?? options.issues).filter(i => issue.agent?.home?.groupId ? i.agent?.home?.groupId === issue.agent.home.groupId : i.id === issue.id);
    const count = Math.max(1, group.length);
    scope.textContent = `${issue.agent?.branch || chat?.gitBranch || 'Workspace'}${target() ? ` → ${target()}` : ''} · ${count} issue${count === 1 ? '' : 's'}`;
    scope.title = `${checkout()}\n${group.map(i => `${i.id}: ${i.title}`).join('\n')}`;
    input.disabled = state === 'done'; input.placeholder = !chat ? 'Add instructions (optional)…' : state === 'ready' ? 'Request a change…' : 'Message to the agent…';
    submit.disabled = busy || active || state === 'done' || Boolean(chat && !input.value.trim());
    if (!chat && !issue.agent?.home) submit.querySelector('span')!.textContent = memory.mode === 'plan' ? 'Start planning' : 'Start build';
    if (!chat && issue.agent?.home) {
      const retry = ['failed', 'paused'].includes(issue.agent.home.state); submit.disabled = busy || !retry; submit.querySelector('span')!.textContent = retry ? 'Retry chat' : 'Queued';
    }
    submit.setAttribute('aria-label', submit.querySelector('span')!.textContent || 'Send message');
    hint.textContent = active ? 'You can draft a message while the agent works. Pause to send it now.' : state === 'done' ? 'Merged. Open in Code or create an issue for further work.' : ''; hint.hidden = !hint.textContent;
    footer.hidden = !chat || !issue.agent?.home; scope.hidden = !chat;
    pause.hidden = !issue.agent?.home || !['working', 'paused', 'rebasing'].includes(state || ''); pause.disabled = busy && !active; pause.querySelector('span')!.textContent = state === 'paused' ? 'Resume' : 'Pause';
    request.hidden = !chat || !ready || Boolean(boardId);
    primary.hidden = !chat || !issue.agent?.home || !ready && state !== 'failed';
    primary.disabled = busy || active || planning && state !== 'failed' && (!savedPlan || savedPlan.type === 'invalid');
    primary.querySelector('span')!.textContent = boardId ? 'Open orchestrator board' : state === 'failed' ? 'Retry agent' : planning ? !savedPlan ? 'Load plan to continue' : savedPlan.type === 'invalid' ? 'Revise plan type' : savedPlan.type === 'orchestrate' ? 'Orchestrate' : 'Approve plan & build' : !snapshot ? 'Review changes' : snapshot.dirty ? 'Ask agent to commit' : state === 'conflict' ? 'Retry merge' : count > 1 ? `Merge ${count} issues into ${target() || 'main'}` : `Merge into ${target() || 'main'}`;
    conflict.hidden = state !== 'conflict';
    const captions: Record<string, string> = { working: 'Agent is working', paused: 'Work is paused', planned: 'Planned · ready to build', ready: chat?.modeId === 'plan' ? 'Plan ready for approval' : `Ready to merge into ${target() || 'main'}`, conflict: 'Merge needs attention', merging: 'Merging changes…', mergequeued: 'Queued to merge', done: 'Work merged', failed: 'Work needs attention', held: 'Waiting on blockers', waitslot: 'Waiting for an agent slot' };
    footerTitle.textContent = boardId ? 'Execution handed to the orchestrator board' : planning && ready ? savedPlan?.type === 'orchestrate' ? 'Plan ready to orchestrate' : 'Plan ready for approval' : issue.agent?.phase === 'awaiting_input' ? 'The agent needs your answer' : captions[state || ''] || (chat ? 'Linked conversation' : 'Start work on this issue');
    footerDetail.textContent = count > 1 ? `Actions apply to ${group.map(i => i.id).join(', ')} in the shared worktree.` : snapshot?.dirty && ready ? 'Uncommitted changes must be committed before merging.' : state === 'done' ? 'The conversation and command history remain available.' : 'Applies to this issue’s worktree.';
    if (!busy && (issue.agent?.error || '') !== lastAgentError) {
      if (issue.agent?.error) error.textContent = issue.agent.error;
      else if (error.textContent === lastAgentError) error.textContent = '';
      lastAgentError = issue.agent?.error || '';
    }
    const maximized = options.isMaximized?.() ?? false; maximize.setAttribute('aria-label', maximized ? 'Restore details size' : 'Maximize details'); maximize.title = maximized ? 'Restore details size' : 'Maximize details'; maximize.setAttribute('aria-pressed', String(maximized));
  }
  function update(): void {
    if (disposed) return;
    issue = findIssueById(issue.id) ?? issue; title.textContent = issue.title;
    planPreview.update(issue);
    const planned = issue.agent?.home?.state === 'planned';
    if (planned && !wasPlanned) { memory.brief = true; brief.hidden = false; briefToggle.setAttribute('aria-expanded', 'true'); }
    wasPlanned = planned;
    updateHomeIssueStatus(issueStatus, issue);
    updateHomeStatus(status, issue.agent?.home?.state, issue.agent?.phase); updateActions();
    const asking = issue.agent?.phase === 'awaiting_input';
    if (asking && !lastQuestion) selectView('conversation'); lastQuestion = asking;
    runView.update(); if (memory.view === 'changes') changeView.refresh();
    const nextRuns = JSON.stringify(chat?.terminalHistory);
    if (runSignature !== nextRuns) { runSignature = nextRuns; tabButtons.get('runs')!.querySelector('span')!.textContent = `Runs${chat?.terminalHistory?.length ? ` · ${chat.terminalHistory.length}` : ''}`; }
  }
  if (chat) {
    content.remove(); latest.remove(); form.remove();
    sharedChat = mountSharedChatHost(conversation, chat, 'home', { openPlan(path) {
      memory.brief = true; brief.hidden = false; briefToggle.setAttribute('aria-expanded', 'true');
      planPreview.open(issue, path, checkout());
    } });
  }
  const unsubscribeStream = subscribeChatStreamActivity(id => { if (id === chat?.id) update(); });
  const unsubscribeEnd = subscribeChatStreamEnd(id => { if (id === chat?.id) queueMicrotask(() => { if (!disposed) { update(); changeView.refresh(true); runView.refresh(); } }); });
  selectView(memory.view); update();
  return { update, dispose() { disposed = true; planPreview.dispose(); memory.draft = input.value; memory.scroll = content.scrollTop; unsubscribeStream(); unsubscribeEnd(); sharedChat?.dispose(); changeView.dispose(); runView.dispose(); terminalCleanup?.(); notifyAskQuestionDisplayContextChanged(); } };
}
