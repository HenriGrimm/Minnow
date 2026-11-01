export type GitErrorChatKind =
  | 'commit'
  | 'merge'
  | 'push'
  | 'pull'
  | 'fetch'
  | 'checkout'
  | 'rebase'
  | 'pr'
  | 'github'
  | 'generic';

export interface GitErrorChatContext {
  /** Effective git worktree root (undefined = main workspace). */
  cwd?: string;
  /** Current branch name when known. */
  branch?: string;
  /** Parsed popover title when available. */
  title?: string;
  /** Parsed popover summary when available. */
  summary?: string;
  workspacePath?: string;
  conflictedFiles?: string[];
  operation?: 'merge' | 'rebase' | 'cherry-pick';
  sourceBranch?: string;
  targetBranch?: string;
  prNumber?: number;
  reviewBeforeFinish?: boolean;
}

const KIND_INTRO: Record<GitErrorChatKind, string> = {
  commit:
    'A git commit failed in Source Control. Diagnose and fix the issue so the commit can succeed.',
  merge:
    'A git merge failed in Source Control. Diagnose and fix the merge issue (conflicts or other blockers).',
  push: 'A git push failed in Source Control. Diagnose and fix the issue so the push can succeed.',
  pull: 'A git pull failed in Source Control. Diagnose and fix the issue so the pull can succeed.',
  fetch: 'A git fetch failed in Source Control. Diagnose and fix the issue so fetch can succeed.',
  checkout:
    'A git checkout failed in Source Control. Diagnose and fix the issue so the branch switch can succeed.',
  rebase:
    'A git rebase failed in Source Control. Diagnose and fix the rebase issue (conflicts or other blockers).',
  pr: 'A GitHub pull request action failed in Source Control. Diagnose and fix the issue using the local gh CLI.',
  github:
    'A GitHub operation failed in Minnow. Diagnose and fix the issue using the local gh CLI.',
  generic: 'A git operation failed in Source Control. Diagnose and fix the issue.',
};

function closingGuidance(kind: GitErrorChatKind): string[] {
  if (kind === 'merge' || kind === 'rebase') {
    return [
      'Use git tools to investigate (`git_status`, diffs, etc.).',
      kind === 'merge'
        ? 'If merge conflicts are present, resolve markers, stage resolved paths, and finish the merge commit. Do not run `git merge --abort` unless I ask.'
        : 'If rebase conflicts are present, resolve markers, stage resolved paths, and continue the rebase. Do not run `git rebase --abort` unless I ask.',
    ];
  }
  if (kind === 'pr' || kind === 'github') {
    return [
      'Use the local `gh` CLI for this repo\'s PRs, issues, and CI. Do not scrape github.com via browser or web-fetch tools.',
      'Use git tools (`git_status`, diffs) when the working tree is involved.',
    ];
  }
  if (kind === 'commit') {
    return [
      'Use git tools to investigate (`git_status`, diffs, etc.).',
      'When the blocker is resolved, stage any needed paths and complete the commit with an appropriate message.',
    ];
  }
  if (kind === 'push' || kind === 'pull' || kind === 'fetch') {
    return [
      'Use git tools to investigate (`git_status`, `git_log`, remotes).',
      'If the remote is ahead, pull or rebase before pushing. Do not force-push unless I ask.',
    ];
  }
  return [
    'Use git tools to investigate (`git_status`, diffs, etc.).',
    'When the blocker is resolved, finish the original git action.',
  ];
}

/** Build the seeded user message for an agent to fix a git or GitHub failure. */
export function buildGitErrorFixSeedMessage(
  kind: GitErrorChatKind,
  error: string,
  ctx?: GitErrorChatContext,
): string {
  const trimmedError = error.trim() || 'Unknown git error';
  const lines: string[] = [KIND_INTRO[kind] ?? KIND_INTRO.generic];

  const title = ctx?.title?.trim();
  const summary = ctx?.summary?.trim();
  if (title) {
    lines.push('', `Parsed as: ${title}`);
  }
  if (summary) {
    lines.push(summary);
  }

  lines.push('', 'Error:', '```', trimmedError, '```');

  const cwd = ctx?.cwd?.trim();
  if (cwd) {
    lines.push('', `Worktree: \`${cwd}\``);
  }

  const branch = ctx?.branch?.trim();
  if (branch) {
    lines.push('', `Branch: \`${branch}\``);
  }

  if (ctx?.operation) lines.push('', `Paused operation: ${ctx.operation}`);
  if (ctx?.sourceBranch) lines.push(`Source branch: ${ctx.sourceBranch}`);
  if (ctx?.targetBranch) lines.push(`Target branch: ${ctx.targetBranch}`);
  if (ctx?.prNumber) lines.push(`Pull request: #${ctx.prNumber}`);
  if (ctx?.prNumber && ctx.sourceBranch) lines.push(`Resolve the PR on its source branch (${ctx.sourceBranch}), using its existing checkout when available. Preserve any dirty checkout before switching branches.`);
  if (ctx?.conflictedFiles?.length) lines.push('', 'Conflicted files:', ...ctx.conflictedFiles.map(path => `- ${path}`));

  if (ctx?.reviewBeforeFinish) {
    lines.push('', 'Inspect the current git status and branch in the specified checkout before editing. The saved failure may be out of date.',
      'Preserve both sets of intended changes and all unrelated local work. Fix the reported blocker, resolve any conflicts, and run relevant checks. Stage only paths needed for this fix.',
      'Do not abort the operation, discard changes, or force-push. Leave the final merge commit or GitHub PR merge for me to review.',
      'If there is no paused merge or rebase, diagnose the actual blocker instead of assuming conflict markers exist.');
    if (kind === 'pr' || kind === 'github') lines.push('Use the local `gh` CLI for this repository.');
  } else {
    lines.push('', ...closingGuidance(kind));
  }

  return lines.join('\n');
}

/** Ensure the Code chat composer is visible before starting a fixer chat. */
async function ensureCodeChatSurface(): Promise<void> {
  const { isCodeOverviewOpen } = await import('./code-overview');
  const { navigateToCodeChat } = await import('../os/router');
  if (isCodeOverviewOpen()) {
    const { closeCodeOverview } = await import('./code-overview');
    closeCodeOverview({ skipNavigate: true, restoreChat: false });
  }
  navigateToCodeChat();
}

/** An idle Build chat can receive a recovery request only in the same checkout. */
export async function getGitErrorCurrentChat(ctx: GitErrorChatContext): Promise<{ id: string; name: string } | null> {
  const { sessionState, getActiveChat } = await import('../state/sessions');
  if (!sessionState?.activeId) return null;
  const [{ resolveChatToolWorkspaceRoot }, { getWorkspacePath },
    { worktreePathsEqual: panelPathsEqual }, { isChatTurnInProgress }, { chatReadOnlyReason, hasUnsettledAgentWork }] = await Promise.all([
    import('../state/chat-worktree'), import('../state/workspace'),
    import('../lib/worktree-list-parse'), import('../chat/chat-turn-guard'), import('../state/chat-relationships'),
  ]);
  const chat = getActiveChat();
  const cwd = resolveChatToolWorkspaceRoot(chat, sessionState.groups) ?? getWorkspacePath();
  if (!ctx.cwd || !panelPathsEqual(cwd, ctx.cwd) || chat.modeId !== 'build' || chat.archivedAt ||
    chatReadOnlyReason(chat) || hasUnsettledAgentWork(chat, isChatTurnInProgress) ||
    chat.worktreeSetupRequired || (chat.gitBranch && ctx.branch && chat.gitBranch !== ctx.branch)) return null;
  return { id: chat.id, name: chat.name || 'Current Build chat' };
}

/** Send through the shared chat engine without replacing the composer's draft. */
export async function sendGitErrorToChat(
  kind: GitErrorChatKind,
  error: string,
  ctx?: GitErrorChatContext,
  currentChatId?: string,
): Promise<string> {
  const [{ getWorkspacePath }, { worktreePathsEqual: panelPathsEqual }] = await Promise.all([
    import('../state/workspace'), import('../lib/worktree-list-parse'),
  ]);
  const workspacePath = ctx?.workspacePath || getWorkspacePath();
  if (ctx?.workspacePath && !panelPathsEqual(ctx.workspacePath, getWorkspacePath())) {
    throw new Error('The workspace changed. Reopen Source Control and try again.');
  }
  if (ctx?.cwd && ctx.branch) {
    const { gitStatus } = await import('../state/git-api');
    const status = await gitStatus(ctx.cwd);
    if (!status.ok) throw new Error(status.error || 'Could not verify the checkout');
    if (status.branch !== ctx.branch) throw new Error('The checkout changed branches. Refresh Source Control and try again.');
  }
  await ensureCodeChatSurface();
  const seed = buildGitErrorFixSeedMessage(kind, error, ctx);
  if (currentChatId) {
    const eligible = await getGitErrorCurrentChat(ctx ?? {});
    if (eligible?.id !== currentChatId) throw new Error('This chat is busy or its checkout changed. Choose a new Build chat.');
    const [{ getActiveChat }, { sendProgrammaticChatText }, { showToast }] = await Promise.all([
      import('../state/sessions'), import('../chat/messaging'), import('./toast'),
    ]);
    const chat = getActiveChat();
    if (chat.id !== currentChatId || (await getGitErrorCurrentChat(ctx ?? {}))?.id !== currentChatId) {
      throw new Error('The active chat changed. Reopen the recovery details and try again.');
    }
    await new Promise<void>((resolve, reject) => {
      let accepted = false;
      void sendProgrammaticChatText(chat, seed, {
        parseSlash: false,
        clearComposerOnSend: false,
        requireCompletedTurn: true,
        onUserMessageAccepted: async () => { accepted = true; resolve(); },
        reportStatus: (level, message) => {
          if (level !== 'err') return;
          if (accepted) showToast(message, 'error'); else reject(new Error(message));
        },
      }).then(resolve, reject);
    });
    return currentChatId;
  }
  const { createChatWithMode } = await import('./sidebar');
  const result = await createChatWithMode({
    modeId: 'build',
    initialUserMessage: seed,
    forceNewChat: true,
    workspacePath,
    gitRecoveryTarget: ctx?.cwd ? { cwd: ctx.cwd, branch: ctx.branch } : undefined,
  });
  if (!result.ok || !result.chatId) throw new Error(result.error || 'Could not create the recovery chat');
  return result.chatId;
}

/** Update a git panel status row: message text plus optional Send to chat action. */
export function renderGitStatusWithSendToChat(
  host: HTMLElement,
  messageEl: HTMLElement,
  message: string,
  isError: boolean,
  sendToChat?: GitErrorChatKind,
  ctx?: GitErrorChatContext,
): void {
  messageEl.textContent = message;
  messageEl.classList.toggle('is-err', isError);
  host.hidden = !message;

  host.querySelector('.git-panel-status-chat-btn')?.remove();

  if (!isError || !message.trim() || !sendToChat) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'git-panel-status-chat-btn';
  btn.textContent = 'Send to chat';
  btn.title = 'Start a new chat and ask the agent to fix this';
  btn.setAttribute('aria-label', 'Send git error to chat');
  btn.addEventListener('click', () => {
    void sendGitErrorToChat(sendToChat, message, ctx).catch(reportHandoffFailure);
  });
  host.appendChild(btn);
}

/** Append Send to chat to a Git Center conflict / error action row. */
export function appendGitErrorSendToChatButton(
  actions: HTMLElement,
  kind: GitErrorChatKind,
  error: string,
  ctx?: GitErrorChatContext,
): void {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'git-panel-action-btn git-panel-status-chat-btn';
  btn.textContent = 'Send to chat';
  btn.title = 'Start a new chat and ask the agent to fix this';
  btn.setAttribute('aria-label', 'Send git error to chat');
  btn.addEventListener('click', () => {
    void sendGitErrorToChat(kind, error, ctx).catch(reportHandoffFailure);
  });
  actions.appendChild(btn);
}

function reportHandoffFailure(error: unknown): void {
  void import('./toast').then(({ showToast }) => showToast(error instanceof Error ? error.message : 'Could not send to chat', 'error'));
}
