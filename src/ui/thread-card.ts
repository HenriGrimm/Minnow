import '../styles/thread-card.css';
import { hasHostSessionToken } from '../api/session-token';
import { isChatTurnInProgress } from '../chat/chat-turn-guard';
import { subscribeFirstMessageSubmission } from '../chat/first-message-submission';
import { findIncompleteToolBatchAtTail } from '../chat/incomplete-tool-batch';
import { getPendingTranscriptMessages } from '../chat/message-queue';
import { getCurrentRoute } from '../os/router';
import { isChatArchived } from '../state/chat-archive';
import { isChatPinned, setChatPinned } from '../state/chat-groups';
import { resolveChatWorktreeRoot } from '../state/chat-worktree';
import { gitStatus } from '../state/git-api';
import { listIssues } from '../state/issues-store';
import { clearActiveGoal, ensureChatHistoryLoaded, getActiveGoal, getChatMessageCount, sessionState } from '../state/sessions';
import { getWorkspacePath, subscribeWorkspace } from '../state/workspace';
import type { Chat, IssueCard, Message } from '../types';
import { createButton } from './components/button';
import { openPopover, type PopoverHandle } from './components/popover';
import { mountGraphiteNewThread } from './graphite-new-thread';
import { createIcon, type IconName } from './icon';
import { createChatWithMode, renderSidebar, setChatsArchivedWithUndo, subscribeSidebarRender } from './sidebar';
import { chatGitState, getWorkspaceGitSummary, refreshSidebarGitFacts, subscribeSidebarGitState } from './sidebar-git-state';
import { mountSurfacePanelToggles, openSurface } from './surfaces/surfaces-column';
import { showToast } from './toast';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, value?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function button(label: string, action: () => void, icon?: IconName, iconOnly = false): HTMLButtonElement {
  const control = el('button', iconOnly ? 'graphite-thread-icon-button' : 'graphite-thread-button');
  control.type = 'button';
  if (icon) control.append(createIcon(icon, { size: 14 }));
  if (iconOnly) {
    control.setAttribute('aria-label', label);
    control.title = label;
  } else {
    control.append(label);
  }
  control.addEventListener('click', action);
  return control;
}

function row(icon: IconName, label: string, detail?: string, monospace = false): HTMLDivElement {
  const element = el('div', 'graphite-thread-card__row');
  const main = el('span', 'graphite-thread-card__row-body');
  main.append(el('span', monospace ? 'graphite-thread-mono' : '', label));
  if (detail) main.append(el('span', 'graphite-thread-card__detail', detail));
  element.append(createIcon(icon, { size: 14 }), main);
  return element;
}

function rowButton(icon: IconName, label: string, detail: string | undefined, action: () => void, monospace = false): HTMLButtonElement {
  const control = button(label, action);
  control.className = 'graphite-thread-card__row graphite-thread-card__row--action';
  control.replaceChildren(...row(icon, label, detail, monospace).childNodes, createIcon('chevronRight', { size: 14 }));
  return control;
}

function activeChat(): Chat | undefined {
  return sessionState?.chats.find(chat => chat.id === sessionState?.activeId);
}

export function findThreadIssue(chat: Chat): IssueCard | undefined {
  return listIssues().find(issue => issue.chatIds?.includes(chat.id) || issue.boardChatId === chat.id || issue.agent?.chatId === chat.id);
}

function appendLineCounts(parent: HTMLElement, { additions, deletions }: { additions: number; deletions: number }): void {
  parent.append(
    el('span', 'graphite-thread-mono graphite-thread-addition', `+${additions}`),
    el('span', 'graphite-thread-mono graphite-thread-deletion', `−${deletions}`),
  );
}

function checkoutFor(chat: Chat): string {
  return resolveChatWorktreeRoot(chat) ?? getWorkspacePath();
}

export async function forkThreadWithModel(chat: Chat): Promise<void> {
  try {
    await ensureChatHistoryLoaded(chat.id);
    if (activeChat()?.id !== chat.id) return;
    if (!chat.history.length) return;
    if (isChatTurnInProgress(chat.id)) throw new Error('Finish or stop the current turn before forking');
    const { openForkModelDialog } = await import('./fork-model-dialog');
    const allowFull = !findIncompleteToolBatchAtTail(chat);
    const selection = await openForkModelDialog(
      { providerId: chat.providerId, modelId: chat.modelId },
      { title: chat.name, allowFull },
    );
    if (!selection || activeChat()?.id !== chat.id) return;
    if (isChatTurnInProgress(chat.id)) throw new Error('Finish or stop the current turn before forking');
    let history: Message[];
    if (selection.carry === 'full' && !findIncompleteToolBatchAtTail(chat)) {
      history = structuredClone(chat.history);
      for (const row of history) {
        if (row.role !== 'user') continue;
        delete row.messageId;
        delete row.commandId;
        delete row.provenance;
      }
    } else {
      const [{ buildFollowupContextSummary }, { emptyCompactionState }] = await Promise.all([
        import('../chat/followup/summary'),
        import('../../server/runner/compaction/index.js'),
      ]);
      if (activeChat()?.id !== chat.id || isChatTurnInProgress(chat.id)) return;
      const summary = buildFollowupContextSummary(chat);
      const tokens = Math.ceil(summary.length / 4);
      history = [{
        role: 'context', policy: 'compact', droppedTurns: 0, summaryText: summary, createdAt: Date.now(),
        compaction: { version: 1, foldThroughIndex: null, state: emptyCompactionState(), trigger: 'manual',
          summary, tokensBefore: tokens, tokensAfter: tokens },
      }];
    }
    const { providerId, modelId } = selection;
    const result = await createChatWithMode({
      modeId: 'general', forceNewChat: true, providerId, modelId,
      fork: {
        sourceChatId: chat.id, name: `${chat.name.replace(/ · fork$/, '')} · fork`, history,
        checkout: resolveChatWorktreeRoot(chat), branch: chat.gitBranch,
      },
    });
    if (!result.ok) throw new Error(result.error || 'Could not create the fork');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not fork this thread', 'error');
  }
}

let currentCard: PopoverHandle | undefined;
let currentCardChat: Chat | undefined;
let branchButton: HTMLButtonElement | undefined;
let goalButton: HTMLButtonElement | undefined;
let goalPopover: PopoverHandle | undefined;
let goalPopoverChat: string | undefined;

async function toggleThreadGoal(chat: Chat, anchor: HTMLElement): Promise<void> {
  if (goalPopover?.isOpen()) {
    goalPopover.close('anchor');
    return;
  }
  const [{ getGoalEvalSession, subscribeGoalEvalSessions }, { isGoalEvaluating }, { maybeContinueGoalAfterTurn }] = await Promise.all([
    import('../chat/goal/eval-session'),
    import('../chat/goal/evaluating-state'),
    import('../chat/goal/evaluate'),
  ]);
  const goal = getActiveGoal(chat);
  if (!goal || activeChat()?.id !== chat.id || !anchor.isConnected || goalPopover?.isOpen()) return;
  const root = el('div', 'graphite-goal-card');
  const heading = el('div', 'graphite-goal-card__heading');
  const state = el('span', 'graphite-goal-card__state');
  heading.append(createIcon('loop', { size: 14 }), el('strong', '', 'Goal'), state,
    button('Close goal', () => goalPopover?.close(), 'clear', true));
  const evaluator = el('div', 'graphite-goal-card__evaluator');
  const evaluatorHeader = el('div', 'graphite-goal-card__heading');
  const rounds = el('span', 'graphite-thread-mono');
  evaluatorHeader.append(el('strong', '', 'Goal evaluator'), rounds);
  const result = el('p', '', '');
  const inspect = button('View evaluator activity', () => {
    goalPopover?.close();
    void import('./goal-eval-drawer').then(({ openGoalEvalDrawer }) => {
      if (activeChat()?.id === chat.id) openGoalEvalDrawer(chat.id);
    });
  }, 'appAgentActivity');
  evaluator.append(evaluatorHeader, result, inspect);
  const controls = el('div', 'graphite-goal-card__actions');
  const stop = button('Stop loop', () => {
    if (activeChat()?.id !== chat.id || getActiveGoal(chat) !== goal) return;
    clearActiveGoal(chat);
    goalPopover?.close();
    void import('./goal-active-hint').then(({ syncGoalActiveHint }) => syncGoalActiveHint());
    renderSidebar();
  }, 'stop');
  const resume = button(goal.achieved ? 'Review changes' : 'Resume loop', () => {
    if (activeChat()?.id !== chat.id || getActiveGoal(chat) !== goal) return;
    if (goal.achieved) {
      goalPopover?.close();
      openSurface('changes', { force: true });
      return;
    }
    if (isChatTurnInProgress(chat.id) || isGoalEvaluating(chat.id)) return;
    resume.disabled = true;
    void ensureChatHistoryLoaded(chat.id).then(() => {
      if (activeChat()?.id === chat.id && getActiveGoal(chat) === goal && !isChatTurnInProgress(chat.id)) return maybeContinueGoalAfterTurn(chat);
    }).catch(error => showToast(error instanceof Error ? error.message : 'Could not resume the goal', 'error')).finally(sync);
  }, goal.achieved ? 'gitGraph' : 'loop');
  controls.append(stop, resume);
  root.append(heading, el('p', 'graphite-goal-card__condition', goal.conditionText), evaluator, controls);

  function sync(): void {
    const latest = getGoalEvalSession(chat.id);
    const running = isGoalEvaluating(chat.id) || isChatTurnInProgress(chat.id);
    state.textContent = goal?.achieved ? 'Achieved' : running ? 'Running' : 'Ready';
    rounds.textContent = `${goal?.turnCount ?? 0} ${goal?.turnCount === 1 ? 'round' : 'rounds'}`;
    result.textContent = latest?.reason || goal?.lastReason || (running ? 'Evaluating…' : 'Waiting for the next round');
    inspect.hidden = !latest;
    stop.hidden = Boolean(goal?.achieved);
    resume.disabled = running && !goal?.achieved;
  }
  sync();
  const unsubscribe = subscribeGoalEvalSessions(latest => { if (latest.chatId === chat.id) queueMicrotask(sync); });
  goalPopoverChat = chat.id;
  goalPopover = openPopover({
    anchor, content: root, className: 'graphite-goal-popover', placement: 'bottom-end',
    ariaLabel: 'Goal', onClose: () => { unsubscribe(); goalPopover = undefined; goalPopoverChat = undefined; },
  });
}

function buildThreadCard(chat: Chat, anchor: HTMLButtonElement): void {
  const content = el('div', 'graphite-thread-card');
  const workspace = getWorkspacePath();
  const overview = el('div', 'graphite-thread-card');
  content.append(overview);
  const isHost = hasHostSessionToken();
  const isCurrent = () => activeChat() === chat && getWorkspacePath() === workspace;
  const action = (run: () => void) => () => {
    currentCard?.close();
    if (isCurrent()) run();
  };
  const reposition = () => currentCard?.reposition();
  let subview: AbortController | undefined;
  let statusRequest: AbortController | undefined;
  let currentBranch: string | undefined;
  let checkoutRow: HTMLButtonElement;

  function showSubview(title: string, returnFocus: () => HTMLButtonElement) {
    subview?.abort();
    subview = new AbortController();
    const { signal } = subview;
    const section = el('section', 'graphite-thread-card__subview');
    section.setAttribute('aria-label', title);
    const toolbar = el('div', 'graphite-thread-card__subview-header');
    const back = button('Back to thread menu', () => {
      subview?.abort();
      subview = undefined;
      section.remove();
      overview.hidden = false;
      reposition();
      returnFocus().focus();
    }, 'chevronLeft', true);
    const heading = el('h2', '', title);
    const host = el('div', 'graphite-thread-card__subview-body');
    toolbar.append(back, heading);
    section.append(toolbar, host);
    overview.hidden = true;
    content.append(section);
    reposition();
    back.focus();
    return { host, toolbar, signal, isCurrent, reposition };
  }

  function showLoadError(panel: ReturnType<typeof showSubview>, message: string): void {
    if (panel.signal.aborted || !isCurrent()) return;
    const notice = el('p', 'graphite-thread-card__notice', message);
    notice.setAttribute('role', 'alert');
    panel.host.replaceChildren(notice);
    reposition();
  }

  function renderOverview(): void {
    statusRequest?.abort();
    statusRequest = new AbortController();
    const { signal } = statusRequest;
    overview.replaceChildren();
    const checkout = checkoutFor(chat);
    const worktree = resolveChatWorktreeRoot(chat);
    if (worktree) refreshSidebarGitFacts(worktree);
    const state = chatGitState(chat, workspace);
    const git = getWorkspaceGitSummary(checkout);
    const issue = findThreadIssue(chat);
    const goal = getActiveGoal(chat);
    const devServer = rowButton('terminal', 'Dev servers', undefined, () => {
      const panel = showSubview('Dev servers', () => devServer);
      void import('./thread-dev-servers').then(({ mountThreadDevServers }) => {
        if (!panel.signal.aborted && isCurrent()) {
          mountThreadDevServers({
            ...panel, workspace, checkout, canManage: isHost,
            isCurrent: () => isCurrent() && checkoutFor(chat) === checkout,
          });
        }
      }).catch(() => showLoadError(panel, 'Could not load dev servers.'));
    });
    checkoutRow = rowButton('gitBranch', (currentBranch ?? git?.branch ?? chat.gitBranch) || 'Checkout',
      worktree ? `worktree · ${worktree.split(/[\\/]/).at(-1)}` : 'main checkout', () => {
        const panel = showSubview('Checkout', () => checkoutRow);
        void import('./thread-checkout').then(({ mountThreadCheckout }) => {
          if (panel.signal.aborted || !isCurrent()) return;
          return mountThreadCheckout({
            ...panel, chat, workspace,
            onChanged: branch => {
              if (!content.isConnected) return;
              const restoreFocus = document.activeElement === checkoutRow;
              currentBranch = branch;
              renderOverview();
              if (!overview.hidden) {
                reposition();
                if (restoreFocus) checkoutRow.focus();
              }
            },
          });
        }).catch(() => showLoadError(panel, 'Could not load checkouts.'));
      }, true);
    const changes = rowButton('gitGraph', 'Changes', undefined, action(() => {
      if (!openSurface('changes', { force: true, target: { kind: 'changes' } })) {
        showToast('Could not open changes.', 'error');
      }
    }));
    const label = changes.querySelector('.graphite-thread-card__row-body > span')!;
    const lines = el('span', 'graphite-thread-card__counts');
    lines.hidden = true;
    changes.insertBefore(lines, changes.lastChild);
    const gitActions = el('div', 'graphite-thread-card__git-actions');
    const commit = createButton({
      label: 'Commit and push', icon: 'gitCommit', size: 'sm', variant: 'ghost',
      onClick: action(() => openSurface('changes', { force: true, target: { kind: 'commit' } })),
    });
    const pullRequest = createButton({
      label: state.prNumber ? 'View PR' : 'Open PR', icon: 'gitPullRequest',
      size: 'sm', variant: 'ghost',
      onClick: action(() => {
        if (state.prNumber && openSurface('pr', { target: state.prNumber })) return;
        void import('./source-control-center').then(({ openSourceControlCenter }) => {
          if (isCurrent()) void openSourceControlCenter({ section: 'pulls', cwd: checkout });
        });
      }),
    });
    gitActions.append(pullRequest);
    overview.append(checkoutRow, changes, gitActions, el('div', 'graphite-thread-card__divider'));

    function syncFileCount(count?: number): void {
      label.textContent = count === undefined ? 'Changes' : count === 0 ? 'No changed files'
        : `${count} changed ${count === 1 ? 'file' : 'files'}`;
      if (!count) commit.remove();
      else if (!commit.parentElement) gitActions.prepend(commit);
    }
    syncFileCount(currentBranch && git?.branch !== currentBranch ? undefined : git?.changed);
    void gitStatus(checkout, signal, { lineStats: true }).then(status => {
      if (signal.aborted || !isCurrent() || checkoutFor(chat) !== checkout || !status.ok) return;
      const entries = [...status.staged ?? [], ...status.unstaged ?? [], ...status.untracked ?? []];
      syncFileCount(new Set(entries.map(file => file.path)).size);
      const measured = entries.filter(file => file.additions !== undefined || file.deletions !== undefined);
      if (!measured.length) return;
      const totals = measured.reduce((sum, file) => ({
        additions: sum.additions + (file.additions ?? 0),
        deletions: sum.deletions + (file.deletions ?? 0),
      }), { additions: 0, deletions: 0 });
      appendLineCounts(lines, totals);
      lines.hidden = false;
      changes.setAttribute('aria-label', `${label.textContent}, ${totals.additions} additions, ${totals.deletions} deletions`);
    });

    const model = row('appModels', chat.modelId || 'No model selected', chat.providerId);
    const fork = button('Fork…', action(() => void forkThreadWithModel(chat)), 'gitBranch');
    fork.disabled = getChatMessageCount(chat) === 0 || Boolean(chat.agentConversation);
    model.append(fork);
    overview.append(devServer, model);

    if (issue) overview.append(rowButton('appIssues', `Issue · ${issue.id}`, issue.title, action(() => {
      if (!openSurface('issue', { target: issue.id })) {
        void import('./issues-page').then(({ openIssues }) => {
          if (isCurrent()) void openIssues({ issueId: issue.id });
        });
      }
    })));
    if (goal) overview.append(rowButton('loop', 'Goal', goal.achieved ? 'Achieved' : goal.conditionText, action(() => {
      if (goalButton) void toggleThreadGoal(chat, goalButton);
    })));

    const footer = el('div', 'graphite-thread-card__footer');
    const pin = button(isChatPinned(chat) ? 'Unpin' : 'Pin', action(() => {
      setChatPinned(chat, !isChatPinned(chat));
      renderSidebar();
    }), 'pin');
    pin.disabled = Boolean(chat.agentConversation);
    footer.append(pin,
      button(isChatArchived(chat) ? 'Restore' : 'Archive', action(() => setChatsArchivedWithUndo([chat], !isChatArchived(chat))), 'archive'),
      el('kbd', 'graphite-thread-card__key', /mac/i.test(navigator.platform) ? '⌘.' : 'Ctrl+.'),
    );
    overview.append(el('div', 'graphite-thread-card__divider'), footer);
  }

  renderOverview();
  const unsubscribeWorkspace = subscribeWorkspace(() => {
    if (!isCurrent()) currentCard?.close();
  });
  currentCardChat = chat;
  currentCard = openPopover({
    anchor,
    content,
    className: 'graphite-thread-card-popover',
    ariaLabel: 'This thread',
    offset: 9,
    onClose: reason => {
      subview?.abort();
      statusRequest?.abort();
      unsubscribeWorkspace();
      currentCard = undefined;
      currentCardChat = undefined;
      if (reason === 'escape') queueMicrotask(() => {
        if (anchor.isConnected && !anchor.hidden && document.activeElement === document.body) {
          anchor.focus({ preventScroll: true });
        }
      });
    },
  });
}

export function toggleThreadCard(): void {
  if (currentCard?.isOpen()) {
    currentCard.close('anchor');
    return;
  }
  const chat = activeChat();
  if (chat && branchButton && !branchButton.hidden && branchButton.getClientRects().length) buildThreadCard(chat, branchButton);
}

export function mountGraphiteThreadHeader(): void {
  const header = document.getElementById('graphiteThreadHeader');
  if (!header || header.dataset.mounted) return;
  header.dataset.mounted = 'true';
  const title = el('h1', 'graphite-thread-title', 'New thread');
  const branchLabel = el('span', 'graphite-thread-mono');
  const branch = button('', toggleThreadCard);
  branch.classList.add('graphite-thread-branch');
  branch.setAttribute('aria-haspopup', 'dialog');
  branch.setAttribute('aria-expanded', 'false');
  branch.setAttribute('aria-label', 'This thread');
  branch.title = 'This thread';
  branch.replaceChildren(createIcon('gitBranch', { size: 12 }), branchLabel, createIcon('chevronDown', { size: 12 }));
  branchButton = branch;

  const actions = el('div', 'graphite-thread-header__actions');
  const goal = button('Goal', () => {
    const chat = activeChat();
    if (chat) void toggleThreadGoal(chat, goal);
  }, 'loop');
  goal.setAttribute('aria-haspopup', 'dialog');
  goal.setAttribute('aria-expanded', 'false');
  goalButton = goal;
  const diff = button('Open Diff', () => openSurface('changes'), 'gitGraph');
  diff.classList.add('graphite-thread-header__diff');
  diff.setAttribute('aria-label', 'Open Diff');
  const toggleHost = el('div', 'graphite-thread-header__panel-toggles');
  mountSurfacePanelToggles(toggleHost);
  const capture = button('Capture issue', () => {
    const chat = activeChat();
    void import('./issue-capture').then(({ openQuickCapture }) => {
      const extra = chat && getChatMessageCount(chat) > 0
        ? { items: [{ kind: 'chat' as const, label: chat.name, chatId: chat.id }] }
        : undefined;
      openQuickCapture({ anchor: capture, extra, thread: true });
    });
  }, 'appIssues', true);
  capture.id = 'btnGraphiteCaptureIssue';
  capture.setAttribute('aria-haspopup', 'dialog');
  capture.setAttribute('aria-expanded', 'false');
  actions.append(goal, diff, capture, toggleHost);
  header.append(title, branch, actions);
  const syncNewThread = mountGraphiteNewThread();

  function refresh(): void {
    const route = getCurrentRoute();
    const chat = activeChat();
    const isThreadView = route.appId === 'code' && (!route.codeSection || route.codeSection === 'chat');
    const hasThread = !!chat && (getChatMessageCount(chat) > 0 || getPendingTranscriptMessages(chat).length > 0);
    header!.hidden = !isThreadView;
    syncNewThread(isThreadView && !hasThread);
    title.textContent = hasThread ? chat.name : 'New thread';
    if (currentCardChat && (currentCardChat !== chat || !isThreadView)) currentCard?.close();
    branch.hidden = !chat;
    goal.hidden = !hasThread || !getActiveGoal(chat!);
    if (goal.hidden || !isThreadView || goalPopoverChat !== chat?.id) goalPopover?.close();
    const totals = chat?.codeChangeTotals;
    diff.hidden = !hasThread || !(totals?.additions || totals?.deletions);
    if (!chat) return;
    const checkout = checkoutFor(chat);
    branchLabel.textContent = getWorkspaceGitSummary(checkout)?.branch || chat.gitBranch || 'This thread';
    if (!diff.hidden && totals) {
      diff.replaceChildren(createIcon('gitGraph', { size: 14 }));
      appendLineCounts(diff, totals);
    }
  }

  subscribeSidebarRender(refresh);
  subscribeFirstMessageSubmission(chat => {
    if (chat === activeChat()) refresh();
  });
  subscribeSidebarGitState(refresh);
  window.addEventListener('hashchange', refresh);
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey || header.hidden) return;
    const mod = /mac/i.test(navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!mod) return;
    if (event.key.toLowerCase() === 'f') {
      const target = event.target;
      if (target instanceof Element && target.closest('.cm-editor, .xterm, .graphite-surface-pane')) return;
      event.preventDefault();
      void import('./chat-search-popover').then(({ toggleChatSearchPopover }) => toggleChatSearchPopover());
      return;
    }
    if (event.key !== '.' || branch.hidden) return;
    event.preventDefault();
    toggleThreadCard();
  });
  refresh();
}
