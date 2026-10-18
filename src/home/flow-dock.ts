import type { Chat, IssueCard } from '../types';
import { sessionState, ensureChatHistoryLoaded } from '../state/sessions';
import { findIssueById } from '../state/issues-store';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { gitDiffSummary, gitStatus } from '../state/git-api';
import { launchApp } from '../os/router';
import { listMainTurnActivity } from '../chat/main-turn-activity';
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { renderUserMessageBubble } from '../ui/user-message-bubble';
import { createIcon } from '../ui/icon';
import { showToast } from '../ui/toast';
import { stripAnsi } from '../lib/strip-ansi';
import { startTerminalRun, streamTerminalRun, cancelTerminalRun } from '../api/terminal';
import { blockers, issueChat } from './flow-model';
import { approveHomeIssue, pauseHomeIssue, replyHomeIssue } from './flow-actions';
import { clearHomeQuestionHost, setHomeQuestionHost } from './question-host';
import { button, el } from './dom';
import { updateHomeStatus } from './status-chip';

export interface DockOptions {
  issue: IssueCard; issues: IssueCard[]; workspace: string; modelLabel: string;
  start: (issue: IssueCard, mode: 'build' | 'plan', instructions: string) => void;
  select: (issue: IssueCard) => void;
  addToChat: (issue: IssueCard, chat: Chat) => void;
}

export function mountIssueDock(host: HTMLElement, options: DockOptions): { update: () => void; dispose: () => void } {
  let { issue } = options;
  const { issues } = options;
  let disposed = false, transcriptSignature = '', historyReady = false;
  const chat = issueChat(issue, sessionState?.chats ?? []);
  const shell = el('div', '', 'home-issue-detail');
  const summary = el('aside', '', 'home-issue-summary');
  const identity = el('div', '', 'home-inline');
  const status = el('span', '', 'home-status');
  identity.append(el('span', issue.id, 'home-mono home-muted'), status);
  summary.append(identity, el('h2', issue.title));
  const table = el('dl', '', 'home-relationships');
  const relation = (label: string, value?: string) => { if (value) table.append(el('dt', label), el('dd', value)); };
  relation('Issue', issue.id); relation('Chat', chat?.name); relation('Worktree', issue.agent?.worktreePath?.split(/[\\/]/).slice(-2).join('/')); relation('Branch', issue.agent?.branch || chat?.gitBranch); relation('Into', issue.agent?.home?.baseBranch);
  summary.append(table);
  const changes = el('div', '', 'home-changes-summary');
  changes.append(el('p', chat?.worktreeRoot ? 'Loading changes…' : 'No worktree yet', 'home-mono home-muted'), button('Source Control', () => launchApp('source-control'), false, 'gitBranch'));
  summary.append(changes, button('Open issue', () => { window.location.hash = `#/app/issues/${encodeURIComponent(issue.id)}`; }, false, 'appIssues'));
  const conversation = el('section', '', 'home-conversation');
  const heading = el('div', '', 'home-chat-heading');
  heading.append(createIcon('comment'), el('span', chat ? `${chat.name} · ${chat.modelId || 'Default model'}` : 'No chat yet'), el('span', chat ? 'last 30 messages' : 'Ready to start', 'home-muted'));
  const content = el('div', '', 'home-chat-history'); content.tabIndex = 0; content.setAttribute('role', 'log'); content.setAttribute('aria-label', 'Issue conversation');
  const questionHost = el('div', '', 'home-questions'); questionHost.id = 'homeFlowQuestions';
  const form = el('form', '', 'home-chat-composer');
  const input = el('textarea'); input.rows = 1;
  input.setAttribute('aria-label', chat ? 'Message to the agent' : 'Instructions before starting');
  const controls = el('div', '', 'home-start-controls');
  const right = el('aside', '', 'home-review-panel');
  const preview = el('div', '', 'home-preview-empty'); preview.append(createIcon('browser'), el('p', 'Preview'), el('span', 'Open the worktree in Code to run and preview the project.', 'home-muted'));
  right.append(preview);
  const checks = el('div', '', 'home-checks');
  checks.append(el('h3', 'Checks'), el('p', 'Review the agent’s reported checks in the conversation. Merge verifies committed changes and conflicts.', 'home-muted'));
  right.append(checks);
  const actions = el('div', '', 'home-review-actions');
  const error = el('p', '', 'home-inline-error'); error.setAttribute('role', 'status');
  const submit = button(chat ? 'Send message' : 'Start chat', () => form.requestSubmit(), true, chat ? 'arrowUp' : 'send');
  submit.setAttribute('aria-label', chat ? 'Send message' : 'Start chat');
  let mode: 'build' | 'plan' = 'build', busy = false;
  const perform = async (action: () => Promise<void>) => {
    if (busy) return; busy = true; submit.disabled = true; error.textContent = '';
    try { await action(); } catch (err) { error.textContent = err instanceof Error ? err.message : String(err); }
    finally { busy = false; if (!disposed) update(); }
  };
  if (chat) {
    input.placeholder = 'Adjust instructions…';
    const sendRow = el('div', '', 'home-chat-input'); sendRow.append(input, submit); form.append(questionHost, sendRow, error);
    actions.append(button('Open chat', () => launchApp('code', { chatId: chat.id }), false, 'externalLink'));
    if (issue.agent?.home) {
      const pause = button('Pause', () => { if (issue.agent?.home?.state === 'paused') void perform(() => replyHomeIssue(issue, 'Continue from where you stopped.')); else pauseHomeIssue(issue); }); pause.dataset.pause = ''; actions.prepend(pause);
      const approve = button('Approve · queue merge', () => void perform(() => approveHomeIssue(issue)), true, 'gitMerge'); approve.dataset.approve = ''; actions.append(approve);
      if (chat.modeId === 'plan') actions.append(button('Approve plan · build', () => void perform(() => replyHomeIssue(issue, 'The plan is approved. Implement it, run checks, commit the work, and stop for review. Do not merge.', true)), true, 'modeBuild'));
      const conflict = el('div', '', 'home-conflict'); conflict.dataset.conflict = '';
      conflict.append(el('p', 'The merge stopped. Your branch and worktree are preserved.'), button('Ask agent to rebase · keep both', () => void perform(() => replyHomeIssue(issue, `Rebase your branch onto ${issue.agent?.home?.baseBranch || 'main'}. Resolve conflicts preserving both intended changes, run checks, commit, and stop for review.`)), false, 'gitRebase'), button('Resolve in Code', () => launchApp('code', { chatId: chat.id })));
      conversation.append(conflict);
    }
  } else {
    input.placeholder = 'Anything the agent should know before it starts? (optional)';
    content.append(el('h3', 'The issue'), el('p', issue.description || 'No description was added.', 'home-issue-description'));
    const waits = blockers(issue, issues, getIssuesTaxonomySync());
    if (waits.length) content.append(el('p', `Waits on ${waits.map(i => i.id).join(', ')}. This issue will be held until its blockers finish.`, 'home-blocked'));
    content.append(el('h3', 'The agent starts with'));
    const context = el('div', '', 'home-context-chips');
    for (const label of ['Issue text', ...(issue.codeRefs ?? []).map(r => r.path), ...(issue.notes ? ['Brain notes'] : []), ...waits.map(i => `${i.id} summary`)]) context.append(el('span', label));
    content.append(context);
    const paths = new Set(issue.codeRefs?.map(r => r.path));
    const related = issues.find(i => i.id !== issue.id && i.agent?.chatId && i.codeRefs?.some(r => paths.has(r.path)));
    const relatedChat = related && issueChat(related, sessionState?.chats ?? []);
    if (relatedChat?.worktreeRoot) {
      const suggestion = el('div', '', 'home-related-chat'); suggestion.append(el('p', `“${relatedChat.name}” is already working in linked files. Adding this there shares its worktree.`), button('Add to that chat', () => options.addToChat(issue, relatedChat))); content.append(suggestion);
    }
    const modes = el('div', '', 'home-segments'); modes.setAttribute('aria-label', 'Chat mode');
    for (const choice of ['build', 'plan'] as const) {
      const pick = button(choice === 'build' ? 'Build' : 'Plan first', () => { mode = choice; for (const b of modes.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === pick)); submit.querySelector('span')!.textContent = mode === 'plan' ? 'Start with a plan' : 'Start chat'; });
      pick.setAttribute('aria-pressed', String(choice === mode)); modes.append(pick);
    }
    controls.append(modes, el('span', `${options.modelLabel} · isolated worktree`, 'home-mono home-muted'), button('Add to selection', () => options.select(issue)), submit);
    form.append(input, controls, error);
    preview.replaceChildren(createIcon('browser'), el('p', 'Preview and checks appear here once the agent makes its first change.', 'home-muted'));
  }
  form.onsubmit = event => {
    event.preventDefault();
    if (!chat) { options.start(issue, mode, input.value.trim()); return; }
    const text = input.value.trim(); if (!text) return;
    // A pending ask_question is answered through its shared question controls.
    void perform(async () => { input.value = ''; await replyHomeIssue(issue, text); });
  };
  input.onkeydown = event => { if (chat && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } };
  conversation.append(heading, content, form);
  right.append(actions, el('p', issue.agent?.branch ? `Merges ${issue.agent.branch} into ${issue.agent.home?.baseBranch || 'main'}. The worktree is removed only after a clean merge.` : 'Each new chat runs in its own worktree.', 'home-affects'));
  shell.append(summary, conversation, right); host.append(shell);
  function update(): void {
    if (disposed) return;
    issue = findIssueById(issue.id) ?? issue;
    const state = issue.agent?.home?.state;
    updateHomeStatus(status, state, issue.agent?.phase);
    input.placeholder = issue.agent?.phase === 'awaiting_input' ? 'Answer using the question controls above…' : state === 'ready' ? 'Request changes…' : chat ? 'Adjust instructions…' : input.placeholder;
    const active = Boolean(chat && listMainTurnActivity().some(t => t.chatId === chat.id));
    submit.disabled = busy || active || state === 'done';
    if (!chat && issue.agent?.home) {
      const retry = ['failed', 'paused'].includes(issue.agent.home.state);
      submit.disabled = busy || !retry; submit.querySelector('span')!.textContent = retry ? 'Retry chat' : 'Queued';
      submit.setAttribute('aria-label', retry ? 'Retry chat' : 'Queued');
    }
    input.disabled = active || state === 'done';
    const approve = actions.querySelector<HTMLButtonElement>('[data-approve]'); if (approve) { approve.hidden = !['ready', 'conflict'].includes(state || '') || chat?.modeId === 'plan'; approve.disabled = busy; approve.querySelector('span')!.textContent = state === 'conflict' ? 'Approve · retry merge' : 'Approve · queue merge'; }
    const pause = actions.querySelector<HTMLButtonElement>('[data-pause]'); if (pause) { pause.hidden = !['working', 'paused', 'rebasing'].includes(state || ''); pause.querySelector('span')!.textContent = state === 'paused' ? 'Resume' : 'Pause'; }
    const conflict = conversation.querySelector<HTMLElement>('[data-conflict]'); if (conflict) conflict.hidden = state !== 'conflict';
    if (issue.agent?.error && !busy) error.textContent = issue.agent.error;
    const commands = (chat?.terminalHistory ?? []).filter(run => run.source === 'agent').slice(-4);
    if (commands.length) {
      checks.replaceChildren(el('h3', 'Checks & commands'));
      for (const run of commands) {
        const line = el('div', '', 'home-check-row');
        const passed = run.exitCode === 0 && !run.timedOut;
        line.append(createIcon(passed ? 'statusPass' : 'statusFail'), el('span', run.command, 'home-mono'), el('span', run.timedOut ? 'timed out' : `exit ${run.exitCode ?? 'stopped'}`, 'home-muted'));
        line.dataset.result = passed ? 'pass' : 'fail'; checks.append(line);
      }
    }
    if (!chat || !historyReady) return;
    const history = chat.history.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool').slice(-30);
    const signature = JSON.stringify(history);
    if (signature === transcriptSignature) return;
    const follow = !transcriptSignature || content.scrollHeight - content.scrollTop - content.clientHeight < 64;
    const scroll = content.scrollTop; transcriptSignature = signature; content.replaceChildren();
    for (const message of history) {
      if (message.role === 'tool') {
        const line = el('details', '', 'home-tool-line'); line.append(el('summary', 'Tool result'), el('pre', typeof message.content === 'string' ? message.content : JSON.stringify(message.content))); content.append(line);
      } else {
        const row = el('div', '', `home-message home-message--${message.role}`);
        if (message.role === 'assistant') setAssistantBubbleContent(row, message.content || '');
        else renderUserMessageBubble(row, message.content, { issue: message.issue, persistedImages: message.images });
        content.append(row);
      }
    }
    if (!history.length) content.append(el('p', active ? 'Agent is starting…' : 'No messages yet.', 'home-muted'));
    content.scrollTop = follow ? content.scrollHeight : scroll;
  }
  if (chat) {
    setHomeQuestionHost(chat.id, questionHost); notifyAskQuestionDisplayContextChanged();
    content.append(el('p', 'Loading conversation…', 'home-muted'));
    void ensureChatHistoryLoaded(chat.id).then(() => { if (!disposed) { historyReady = true; update(); } }).catch(() => { if (!disposed) content.replaceChildren(el('p', 'Could not load the conversation. Open the chat to retry.', 'home-muted')); });
    if (chat.worktreeRoot) void Promise.all([gitStatus(chat.worktreeRoot), gitDiffSummary(chat.worktreeRoot)]).then(([status, diff]) => {
      if (disposed) return;
      const count = new Set([...(status.staged ?? []), ...(status.unstaged ?? []), ...(status.untracked ?? [])].map(f => f.path)).size;
      changes.firstElementChild!.textContent = status.ok ? `${count} uncommitted files${diff.ok ? ` · +${diff.additions ?? 0} −${diff.deletions ?? 0}` : ''}` : 'Changes unavailable';
    });
  }
  update();
  return { update, dispose() { disposed = true; clearHomeQuestionHost(); notifyAskQuestionDisplayContextChanged(); } };
}

/** A scoped command console uses the same terminal service as Code. */
export function mountHomeTerminal(host: HTMLElement, workspace: string, chat?: Chat): () => void {
  let runId = '', disposed = false;
  const abort = new AbortController();
  const consoleHost = el('div', '', 'home-terminal');
  const output = el('pre', 'Run a command in this checkout.\n', 'home-terminal-output'); output.tabIndex = 0; output.setAttribute('aria-label', 'Terminal output');
  const form = el('form', '', 'home-terminal-form'); const input = el('input'); input.placeholder = 'Enter a command…'; input.setAttribute('aria-label', 'Terminal command');
  const send = button('Run', () => form.requestSubmit(), true);
  const stop = button('Stop', () => { if (runId) void cancelTerminalRun(runId); }); stop.disabled = true;
  form.append(el('span', '›', 'home-mono'), input, send, stop);
  form.onsubmit = event => {
    event.preventDefault(); if (!input.value.trim() || runId) return;
    const command = input.value.trim(); input.value = ''; output.textContent += `\n› ${command}\n`; send.disabled = true;
    void (async () => {
      try {
        const run = await startTerminalRun({ command, shell: true, chatId: chat?.id || '', source: 'user', workspaceRoot: chat?.worktreeRoot || workspace });
        runId = run.runId; stop.disabled = false;
        await streamTerminalRun(runId, event => {
          if (disposed) return;
          if (event.type === 'stdout' || event.type === 'stderr') output.textContent = (output.textContent + stripAnsi(event.text)).slice(-100000);
          else if (event.type === 'exit') output.textContent += `\nExited ${event.code ?? 'stopped'}\n`;
          else if (event.type === 'error') output.textContent += `\n${event.message}\n`;
          output.scrollTop = output.scrollHeight;
        }, abort.signal);
      } catch (error) { if (!disposed) showToast(error instanceof Error ? error.message : String(error), 'error'); }
      finally { runId = ''; send.disabled = false; stop.disabled = true; }
    })();
  };
  consoleHost.append(el('p', chat?.worktreeRoot || workspace, 'home-mono home-muted'), output, form); host.append(consoleHost);
  return () => { disposed = true; abort.abort(); };
}
