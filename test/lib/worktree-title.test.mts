import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatWorktreeOptionLabel,
  humanizeWorktreeBranch,
  humanizeWorktreeSlug,
  isOpaqueWorktreeName,
  worktreeBranchDetail,
  worktreeTitle,
} from '../../src/lib/worktree-title.ts';

const CHAT_SLOT = 'C:/Users/me/.minnow/worktrees/Minnow-5aaf9e8b/chat/bf1049fa-8374-4388-a23f-fc6478c8df70';
const AGENT_SLOT = 'C:/Users/me/.minnow/worktrees/Minnow-5aaf9e8b/chat/agent-0123456789abcdef0123';

describe('humanizeWorktreeBranch', () => {
  it('drops the minnow prefix and hash suffix of chat branches', () => {
    assert.equal(
      humanizeWorktreeBranch('minnow/min-14-improve-worktree-titling-and-display-1020641411'),
      'MIN-14 Improve worktree titling and display',
    );
    assert.equal(humanizeWorktreeBranch('minnow/fix-login-bug-004211'), 'Fix login bug');
    assert.equal(humanizeWorktreeBranch('minnow/fix-login-bug-004211-2'), 'Fix login bug');
    assert.equal(humanizeWorktreeBranch('refs/heads/minnow/worktree-3f9a1c'), 'Worktree');
  });

  it('keeps trailing words that only look like hex', () => {
    assert.equal(humanizeWorktreeBranch('minnow/remove-deface'), 'Remove deface');
  });

  it('titles sub-agent, board and watch branches', () => {
    assert.equal(humanizeWorktreeBranch('minnow/agent-0123456789abcdef0123'), 'Sub-agent worktree');
    assert.equal(humanizeWorktreeBranch('minnow/board/b1/integration'), 'Board integration');
    assert.equal(humanizeWorktreeBranch('minnow/board/b1/auth-refactor-wave2-W2-A'), 'Auth refactor · Wave 2 · W2-A');
    assert.equal(
      humanizeWorktreeBranch('minnow/board/b1/a-very-long-board-name-that-was-truncated-wave1-W1-A-0123456789ab'),
      'A very long board name that was truncated · Wave 1 · W1-A',
    );
    assert.equal(humanizeWorktreeBranch('minnow/watch/b1/base'), 'Watch checkout');
  });

  it('leaves user-named branches untouched', () => {
    assert.equal(humanizeWorktreeBranch('feature/login-page'), 'feature/login-page');
    assert.equal(humanizeWorktreeBranch('main'), 'main');
  });
});

describe('humanizeWorktreeSlug', () => {
  it('reads issue keys and sentence-cases the rest', () => {
    assert.equal(humanizeWorktreeSlug('abc-123-do-the-thing'), 'ABC-123 Do the thing');
    assert.equal(humanizeWorktreeSlug('docs/update_readme'), 'Docs / Update readme');
    assert.equal(humanizeWorktreeSlug(''), '');
  });
});

describe('isOpaqueWorktreeName', () => {
  it('flags ids and hashes but not readable folders', () => {
    assert.equal(isOpaqueWorktreeName('bf1049fa-8374-4388-a23f-fc6478c8df70'), true);
    assert.equal(isOpaqueWorktreeName('agent-0123456789abcdef'), true);
    assert.equal(isOpaqueWorktreeName('feature-x'), false);
    assert.equal(isOpaqueWorktreeName('integration'), false);
  });
});

describe('worktreeTitle', () => {
  it('never shows a chat slot id', () => {
    assert.equal(worktreeTitle({ path: CHAT_SLOT }), 'Worktree');
    assert.equal(worktreeTitle({ path: CHAT_SLOT, detached: true }), 'Detached worktree');
    assert.equal(
      worktreeTitle({ path: CHAT_SLOT, branch: 'minnow/fix-login-bug-004211' }),
      'Fix login bug',
    );
  });

  it('prefers the owning chat title for generated checkouts only', () => {
    assert.equal(
      worktreeTitle({ path: AGENT_SLOT, branch: 'minnow/agent-0123456789abcdef0123' }, { chatTitle: 'Review auth module' }),
      'Review auth module',
    );
    assert.equal(
      worktreeTitle({ path: '/repo/.worktrees/feature-x', branch: 'feature/x' }, { chatTitle: 'Some chat' }),
      'feature-x',
    );
    assert.equal(worktreeTitle({ path: CHAT_SLOT, branch: 'feature/x' }), 'feature/x');
  });

  it('names the principal checkout after its folder', () => {
    assert.equal(worktreeTitle({ path: '/repo/minnow', branch: 'main' }, { principalPath: '/repo/minnow' }), 'minnow');
    assert.equal(worktreeTitle({ path: '/repo/minnow', branch: 'main' }, { workspaceRoot: '/repo/minnow' }), 'minnow');
  });

  it('titles a chat slot that is itself the workspace by its branch', () => {
    assert.equal(
      worktreeTitle({ path: CHAT_SLOT, branch: 'minnow/fix-login-bug-004211' }, { workspaceRoot: CHAT_SLOT }),
      'Fix login bug',
    );
  });
});

describe('worktreeBranchDetail', () => {
  it('only repeats branches people named themselves', () => {
    assert.equal(worktreeBranchDetail({ branch: 'minnow/fix-004211' }, 'Fix'), '');
    assert.equal(worktreeBranchDetail({ branch: 'feature/x' }, 'feature/x'), '');
    assert.equal(worktreeBranchDetail({ branch: 'feature/x' }, 'Login work'), 'feature/x');
    assert.equal(worktreeBranchDetail({ detached: true }, 'Worktree'), 'detached');
  });
});

describe('formatWorktreeOptionLabel', () => {
  it('uses the owning chat title instead of a slot id', () => {
    const label = formatWorktreeOptionLabel(
      { path: CHAT_SLOT, head: 'abc', branch: 'minnow/min-14-improve-worktree-titling-and-display-1020641411', detached: false },
      '/repo/main',
      { chatTitleFor: (path) => (path === CHAT_SLOT ? 'Improve Worktree titling and display' : undefined) },
    );
    assert.equal(label, 'Improve Worktree titling and display');
  });

  it('humanizes a generated branch on the workspace row', () => {
    assert.equal(
      formatWorktreeOptionLabel({ path: CHAT_SLOT, head: 'abc', branch: 'minnow/fix-login-bug-004211', detached: false }, CHAT_SLOT),
      'Fix login bug — workspace',
    );
  });

  it('keeps user folders and branches verbatim', () => {
    assert.equal(
      formatWorktreeOptionLabel({ path: '/repo/.worktrees/feature-x', head: 'abc', branch: 'feature/x', detached: false }, '/repo/main'),
      'feature-x — feature/x',
    );
    assert.equal(
      formatWorktreeOptionLabel(
        { path: '/repo/.worktrees/feature', head: 'abc', branch: 'feature', detached: false },
        '/repo/main',
        { chatTitleFor: () => 'Login work' },
      ),
      'feature',
    );
  });
});
