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

  lines.push('', ...closingGuidance(kind));

  return lines.join('\n');
}

/** Ensure the Code chat composer is visible before starting a fixer chat. */
async function ensureCodeChatSurface(): Promise<void> {
  const { isCodeOverviewOpen } = await import('./code-overview');
  if (!isCodeOverviewOpen()) return;
  const { closeCodeOverview } = await import('./code-overview');
  const { navigateToCodeChat } = await import('../os/router');
  closeCodeOverview({ skipNavigate: true, restoreChat: false });
  navigateToCodeChat();
}

/** Start a new Build chat seeded with instructions to fix a git/GitHub error. */
export async function sendGitErrorToChat(
  kind: GitErrorChatKind,
  error: string,
  ctx?: GitErrorChatContext,
): Promise<void> {
  await ensureCodeChatSurface();
  const { createChatWithMode } = await import('./sidebar');
  const seed = buildGitErrorFixSeedMessage(kind, error, ctx);
  createChatWithMode({
    modeId: 'build',
    initialUserMessage: seed,
  });
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
    void sendGitErrorToChat(sendToChat, message, ctx);
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
    void sendGitErrorToChat(kind, error, ctx);
  });
  actions.appendChild(btn);
}
