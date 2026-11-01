import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { installComponentDom, type ComponentDom } from './components/component-dom.mts';

let eligible = true;
let sendError = '';
let resolveEligibility: ((value: { id: string; name: string } | null) => void) | undefined;
const deliveries: unknown[][] = [];
mock.module('../../src/ui/git-error-to-chat.ts', { namedExports: {
  getGitErrorCurrentChat: async () => {
    if (resolveEligibility) return new Promise(resolve => { resolveEligibility = resolve; });
    return eligible ? { id: 'current', name: 'Build search' } : null;
  },
  sendGitErrorToChat: async (...args: unknown[]) => {
    deliveries.push(args);
    if (sendError) throw new Error(sendError);
    return 'fix-chat';
  },
} });
const { createGitRecoveryNotice, openGitRecoveryPopover, closeGitRecoveryPopover, describeGitRecovery } = await import('../../src/ui/git-recovery.ts');
const ctx = { cwd: '/repo/worktree', branch: 'feature', operation: 'merge' as const, conflictedFiles: ['src/search.ts'] };
let dom: ComponentDom;
beforeEach(() => { dom = installComponentDom(); eligible = true; sendError = ''; resolveEligibility = undefined; deliveries.length = 0; });
afterEach(() => { closeGitRecoveryPopover(); dom.cleanup(); });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('failure opens the shared popover with Minnow icons, checkout context, hidden raw output and current chat', async () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  const handle = openGitRecoveryPopover({ anchor, kind: 'pull', error: 'CONFLICT (content): src/search.ts', ctx });
  await settle();
  assert.equal(handle.root.getAttribute('aria-label'), 'Pull paused by conflicts');
  assert.ok(handle.root.classList.contains('mn-occludes-preview'));
  assert.ok(handle.root.querySelector('.fi-rr-code-merge'));
  assert.ok(handle.root.querySelector('.mn-btn--primary'));
  assert.equal(handle.root.querySelector('details')?.open, false);
  assert.equal(handle.root.querySelector('select')?.value, 'current');
  assert.equal(anchor.getAttribute('aria-expanded'), 'true');
  dom.key(handle.root, 'Escape');
  assert.equal(handle.isOpen(), false);
  assert.equal(document.activeElement, anchor);
});

test('handoff preserves checkout metadata and shows delivery errors with retry', async () => {
  const anchor = document.createElement('button'); document.body.append(anchor);
  const sent: string[] = [];
  const handle = openGitRecoveryPopover({ anchor, kind: 'pull', error: 'CONFLICT', ctx, onSent: id => sent.push(id) });
  await settle();
  sendError = 'This chat is busy. Choose a new Build chat.';
  const send = handle.root.querySelector<HTMLButtonElement>('.mn-btn--primary')!;
  send.click(); await settle();
  assert.equal(handle.isOpen(), true);
  assert.equal(handle.root.querySelector('[role="alert"]')?.textContent, sendError);
  assert.equal(send.disabled, false);
  sendError = '';
  handle.root.querySelector('select')!.value = 'new';
  send.click(); await settle();
  assert.deepEqual(sent, ['fix-chat']);
  assert.equal(handle.isOpen(), false);
  const [kind, , captured, current] = deliveries.at(-1)! as [string, string, typeof ctx & { reviewBeforeFinish: boolean }, string | undefined];
  assert.equal(kind, 'pull'); assert.equal(captured.cwd, ctx.cwd);
  assert.equal(captured.reviewBeforeFinish, true); assert.equal(current, undefined);
});

test('an unavailable current chat defaults to a new Build chat', async () => {
  eligible = false;
  const anchor = document.createElement('button'); document.body.append(anchor);
  const handle = openGitRecoveryPopover({ anchor, kind: 'merge', error: 'CONFLICT', ctx });
  await settle();
  assert.equal(handle.root.querySelector('select')?.value, 'new');
});

test('the async chat option stays after the themed select button without duplicating choices', async () => {
  resolveEligibility = () => {};
  const anchor = document.createElement('button'); document.body.append(anchor);
  const handle = openGitRecoveryPopover({ anchor, kind: 'merge', error: 'CONFLICT', ctx });
  const select = handle.root.querySelector('select')!;
  const button = document.createElement('button');
  button.className = 'mn-select-button';
  button.append(document.createElement('selectedcontent'));
  select.prepend(button);
  resolveEligibility!({ id: 'current', name: 'Build search' });
  await settle();
  assert.equal(select.firstElementChild, button);
  assert.deepEqual([...select.options].map(option => [option.value, option.textContent]), [
    ['current', 'Current Build chat'], ['new', 'New Build chat'],
  ]);
  assert.equal(select.value, 'current');
});

test('file actions use the failed checkout and render paths as text', () => {
  const anchor = document.createElement('button'); document.body.append(anchor);
  const opened: unknown[][] = [];
  const path = '<img src=x onerror=alert(1)>.ts';
  const handle = openGitRecoveryPopover({ anchor, kind: 'merge', error: '<script>bad()</script>', ctx: { ...ctx, conflictedFiles: [path] }, onOpenFile: (...args) => opened.push(args) });
  assert.equal(handle.root.querySelector('img,script'), null);
  (handle.root.querySelector('.git-recovery-popover__file') as HTMLButtonElement).click();
  assert.deepEqual(opened, [[path, ctx.cwd]]);
  assert.equal(handle.isOpen(), false);
});

test('polling retains the conflict notice and open popover, then changes to review after staging', () => {
  let reviewed = false;
  const notice = createGitRecoveryNotice({ onOpenFile() {}, onReview() { reviewed = true; } });
  document.body.append(notice.root);
  const status = { ok: true, operation: 'merge' as const, conflicted: [{ path: 'src/search.ts', status: 'U' }] };
  notice.sync(status, ctx);
  notice.showFailure({ error: 'CONFLICT', kind: 'pull', ctx });
  const popover = document.querySelector('.git-recovery-popover');
  notice.sync(status, ctx);
  assert.equal(document.querySelector('.git-recovery-popover'), popover);
  assert.equal(notice.root.hidden, false);
  notice.sync({ ok: true, operation: 'merge', conflicted: [] }, ctx);
  assert.equal(document.querySelector('.git-recovery-popover'), null);
  assert.match(notice.root.textContent!, /ready for review/);
  notice.root.querySelector('button')!.click();
  assert.equal(reviewed, true);
  notice.sync({ ok: true, conflicted: [] }, ctx);
  assert.equal(notice.root.hidden, true);
});

test('switching checkout or branch dismisses stale recovery details', () => {
  const notice = createGitRecoveryNotice({ onOpenFile() {}, onReview() {} }); document.body.append(notice.root);
  notice.showFailure({ error: 'CONFLICT', kind: 'merge', ctx });
  notice.sync({ ok: true }, { cwd: '/other', branch: 'main' });
  assert.equal(notice.root.hidden, true);
  assert.equal(document.querySelector('.git-recovery-popover'), null);
});

test('a rejected push and a remote PR conflict never claim a local merge is paused', () => {
  const push = describeGitRecovery({ kind: 'push', error: '[rejected] non-fast-forward', ctx: {} });
  assert.equal(push.title, 'Push rejected');
  const pr = describeGitRecovery({ kind: 'pr', error: 'mergeable: CONFLICTING', ctx: {} });
  assert.equal(pr.title, 'Pull request has merge conflicts');
  assert.doesNotMatch(pr.summary, /paused|Git stopped/);
});
