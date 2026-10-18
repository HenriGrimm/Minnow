import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import serverDOMPurify from 'isomorphic-dompurify';
import type { IssueCard } from '../../src/types.ts';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { mountIssuePlanPreview } from '../../src/ui/issues-plan-preview.ts';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const card = (): IssueCard => ({ id: 'MIN-42', title: 'Plan preview', type: 'task', description: '', status: 'planned', priority: 'none', labels: [], workspacePath: '/repo', createdAt: 1, updatedAt: 1,
  agent: { agentId: 'builder', phase: 'review', startedAt: 1, updatedAt: 2, chatId: 'planner', home: { groupId: 'batch', state: 'planned', mode: 'plan', modelId: 'test', baseBranch: 'main' } } });

function savedPlanHistory(path: string) {
  return [
    { role: 'assistant' as const, content: null, tool_calls: [{ id: 'save', type: 'function' as const, function: { name: 'save_file', arguments: JSON.stringify({ path, content: '# The plan' }) } }] },
    { role: 'tool' as const, tool_call_id: 'save', content: `Saved ${path} (10 bytes)` },
  ];
}

test('details render saved plan markdown from its planning worktree, including older unlinked plans', async () => {
  const win = new Window();
  const requests: URL[] = [];
  installHappyDomGlobals(win, { fetch: (async input => {
    requests.push(new URL(String(input), 'http://localhost'));
    return new Response('---\nname: Execution plan\n---\n# Implementation\n\n- **Build the preview**\n\n<script>window.bad = true</script>');
  }) as typeof fetch });
  const original = DOMPurify.sanitize; DOMPurify.sanitize = serverDOMPurify.sanitize;
  const chat = seedMinimalSession('planner'); chat.modeId = 'plan'; chat.worktreeRoot = '/repo/.worktrees/planner';
  chat.history = savedPlanHistory('documentation/plans/saved-plan.md');
  const host = document.createElement('div'); document.body.append(host);
  const preview = mountIssuePlanPreview(host);
  try {
    preview.update(card()); await flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get('workspaceRoot'), chat.worktreeRoot);
    assert.equal(requests[0].searchParams.get('raw'), '1');
    assert.match(requests[0].pathname, /documentation\/plans\/saved-plan.md/);
    assert.equal(host.querySelector('h1')?.textContent, 'Implementation', host.innerHTML);
    assert.equal(host.querySelector('strong')?.textContent, 'Build the preview');
    assert.equal(host.querySelector('script'), null);
    assert.doesNotMatch(host.textContent!, /name: Execution plan/);
    const issue = card(); issue.planPath = 'documentation/plans/explicit.md';
    preview.update(issue); await flush();
    assert.match(requests.at(-1)!.pathname, /explicit.md/);
  } finally { preview.dispose(); DOMPurify.sanitize = original; await teardownHappyDomAsync(win); }
});

test('details expose load failures and retry, and discard stale plan loads on issue changes', async () => {
  const win = new Window();
  let resolveOld!: (value: Response) => void;
  let count = 0;
  installHappyDomGlobals(win, { fetch: (async () => {
    count++;
    if (count === 1) return new Promise<Response>(resolve => { resolveOld = resolve; });
    return new Response('', { status: 404 });
  }) as typeof fetch });
  seedMinimalSession('planner');
  const host = document.createElement('div'); document.body.append(host);
  const preview = mountIssuePlanPreview(host);
  try {
    const issue = card(); issue.planPath = 'documentation/plans/old.md';
    preview.update(issue); await flush();
    preview.update({ ...issue, id: 'MIN-43', planPath: 'documentation/plans/new.md' }); await flush();
    assert.match(host.textContent!, /Could not load the saved plan/);
    const retry = host.querySelector<HTMLButtonElement>('button')!;
    assert.equal(retry.hidden, false);
    retry.click(); await flush(); assert.equal(count, 3);
    resolveOld(new Response('# Stale plan')); await flush();
    assert.doesNotMatch(host.textContent!, /Stale plan/);
    assert.match(host.querySelector('.issues-plan-preview__path')!.textContent!, /new.md/);
    preview.dispose(); assert.equal(host.children.length, 0);
  } finally { preview.dispose(); await teardownHappyDomAsync(win); }
});

test('opening a plan from a conversation reveals that exact file without changing the issue approval plan', async () => {
  const win = new Window(); const requests: URL[] = [];
  installHappyDomGlobals(win, { fetch: (async input => {
    requests.push(new URL(String(input), 'http://localhost'));
    return new Response('# Clicked plan\n\nReview this specific plan.');
  }) as typeof fetch });
  const original = DOMPurify.sanitize; DOMPurify.sanitize = serverDOMPurify.sanitize;
  seedMinimalSession('planner');
  const host = document.createElement('div'); document.body.append(host);
  const approvalPlans: unknown[] = [];
  const preview = mountIssuePlanPreview(host, plan => approvalPlans.push(plan));
  try {
    const issue = card(); issue.agent = undefined;
    preview.update(issue);
    assert.equal(host.querySelector<HTMLElement>('section')!.hidden, true);
    const before = approvalPlans.length;
    preview.open(issue, 'documentation/plans/from-chat.md', '/repo/.worktrees/old-planner');
    await flush();
    assert.equal(host.querySelector<HTMLElement>('section')!.hidden, false);
    assert.equal(requests[0].searchParams.get('workspaceRoot'), '/repo/.worktrees/old-planner');
    assert.match(requests[0].pathname, /from-chat.md/);
    assert.equal(host.querySelector('h1')?.textContent, 'Clicked plan');
    assert.equal(document.activeElement, host.querySelector('h3'));
    assert.equal(approvalPlans.length, before, 'previewing a chat artifact keeps the approval source unchanged');
    preview.update(issue); await flush();
    assert.equal(requests.length, 1, 'routine detail updates retain the opened plan');
  } finally { preview.dispose(); DOMPurify.sanitize = original; await teardownHappyDomAsync(win); }
});

test('opening a chat plan while the approval plan loads keeps approval available without replacing the opened preview', async () => {
  const win = new Window(); let resolveApproval!: (response: Response) => void;
  installHappyDomGlobals(win, { fetch: (async input => {
    if (String(input).includes('approval.md')) return new Promise<Response>(resolve => { resolveApproval = resolve; });
    return new Response('# Opened from chat');
  }) as typeof fetch });
  const original = DOMPurify.sanitize; DOMPurify.sanitize = serverDOMPurify.sanitize;
  seedMinimalSession('planner');
  const host = document.createElement('div'); document.body.append(host);
  const approvalPaths: Array<string | null> = [];
  const preview = mountIssuePlanPreview(host, plan => approvalPaths.push(plan?.path ?? null));
  try {
    const issue = card(); issue.planPath = 'documentation/plans/approval.md';
    preview.update(issue); await flush();
    preview.open(issue, 'documentation/plans/from-chat.md', '/repo/.worktrees/planner'); await flush();
    resolveApproval(new Response('---\nplanType: build\n---\n# Approval plan')); await flush();
    assert.deepEqual(approvalPaths, [null, 'documentation/plans/approval.md']);
    assert.equal(host.querySelector('h1')?.textContent, 'Opened from chat');
    assert.match(host.querySelector('.issues-plan-preview__path')!.textContent!, /from-chat.md/);
  } finally { preview.dispose(); DOMPurify.sanitize = original; await teardownHappyDomAsync(win); }
});
