import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { createEmptyChatObject, setSessionStateForTests, sessionState } from '../../src/state/sessions.ts';
import { findIssueById, setIssuesStateForTests } from '../../src/state/issues-store.ts';
import { disposeChatRunActivity, setChatRunActivity } from '../../src/state/chat-run-activity.ts';
import type { IssueCard } from '../../src/types.ts';
import type { IssueWorkSnapshot } from '../../src/state/git-api.ts';

let calls: Array<{ action: string; input: any }> = [];
let inspect: IssueWorkSnapshot = {} as IssueWorkSnapshot;
let result: IssueWorkSnapshot = {} as IssueWorkSnapshot;
const originalFetch = globalThis.fetch;
const { mountIssueWorkspace } = await import('../../src/ui/issues-work-panel.ts');
let dom: Window;
let mounted: ReturnType<typeof mountIssueWorkspace> | undefined;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const click = (label: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label);
  assert.equal(Boolean(button), true, `Missing button: ${label}`);
  button!.click();
};

beforeEach(() => {
  dom = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, NodeFilter: dom.NodeFilter });
  DOMPurify.sanitize = DOMPurify(dom as any).sanitize;
  setLocalServerAvailableForTests(true);
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body || '{}'));
    const action = String(input.op || '').replace('issueWork', '');
    calls.push({ action, input });
    return new Response(JSON.stringify(action === 'Inspect' ? inspect : result), { headers: { 'Content-Type': 'application/json' } });
  };
  const chat = createEmptyChatObject('model', 'C:/repo');
  chat.id = 'issue-chat'; chat.modeId = 'build'; chat.worktreeRoot = 'C:/worktree'; chat.chatWorktreeManaged = true;
  chat.history = [{ role: 'user', content: 'Fix it' }, { role: 'assistant', content: 'Fixed. The regression test passed.' }];
  setSessionStateForTests({ chats: [chat], activeId: chat.id });
  const issue: IssueCard = { id: 'MIN-1', title: 'Fix it', type: 'bug', status: 'review', priority: 'medium', labels: [], description: 'Keep the original description.', workspacePath: 'C:/repo', createdAt: 1, updatedAt: 1, chatIds: [chat.id] };
  setIssuesStateForTests({ version: 2, nextId: 2, issues: [issue], workspaces: {} });
  inspect = { ok: true, isolated: true, sourceBranch: 'issue/fix', targetBranch: 'main', sourceHead: 'a'.repeat(40), targetHead: 'b'.repeat(40), fingerprint: 'reviewed', dirty: true, ahead: 1, files: ['src/fix.ts'], patch: '+ reviewed change' };
  result = { ok: true, merged: true, sha: 'c'.repeat(40), targetBranch: 'main', sourceBranch: 'issue/fix', worktreeRemoved: true, branchRemoved: true };
  calls = [];
  const panel = document.createElement('div');
  const sticky = document.createElement('header');
  const body = document.createElement('div');
  const doc = document.createElement('div');
  const editor = document.createElement('textarea');
  editor.value = 'Unsubmitted editor contents'; doc.append(editor); body.append(doc); panel.append(sticky, body); document.body.append(panel);
  mounted = mountIssueWorkspace({ panel, sticky, document: doc, issueBody: body, issue, tab: 'Issue', onTab: () => {}, onStartChat: () => {} });
});
afterEach(() => { mounted?.dispose(); mounted = undefined; disposeChatRunActivity(); setIssuesStateForTests(null); setLocalServerAvailableForTests(false); globalThis.fetch = originalFetch; dom.happyDOM.abort(); });

test('tabs preserve the existing issue editor and show the same linked chat', async () => {
  const editor = document.querySelector('textarea')!;
  click('Work'); await flush();
  assert.equal(editor.value, 'Unsubmitted editor contents');
  click('Chat'); await flush();
  assert.match(document.querySelector('.issues-work-content')!.textContent!, /Fixed\. The regression test passed/);
  click('Issue');
  assert.equal(document.querySelector('textarea') === editor, true);
  assert.equal(editor.value, 'Unsubmitted editor contents');
});

test('merge sends the reviewed snapshot and records delivery without deleting the chat', async () => {
  click('Work'); await flush();
  click('Commit & merge');
  click('Merge into main'); await flush();
  const merge = calls.find((entry) => entry.action === 'Merge')!;
  assert.equal(merge.input.sourceHead, 'a'.repeat(40));
  assert.equal(merge.input.targetHead, 'b'.repeat(40));
  assert.equal(merge.input.fingerprint, 'reviewed');
  assert.equal(merge.input.cleanup, true);
  assert.equal(findIssueById('MIN-1')!.status, 'done');
  assert.equal(findIssueById('MIN-1')!.chatIds?.[0], 'issue-chat');
  assert.equal(findIssueById('MIN-1')!.activity?.at(-1)?.kind, 'work-merged');
});

test('merge failure keeps the issue in Review and exposes retry information', async () => {
  result = { ok: false, conflict: true, error: 'Merge conflict. Worktree preserved.' };
  click('Work'); await flush(); click('Commit & merge'); click('Merge into main'); await flush();
  assert.equal(findIssueById('MIN-1')!.status, 'review');
  assert.match(document.body.textContent!, /Merge conflict\. Worktree preserved/);
  assert.equal(findIssueById('MIN-1')!.activity?.some((entry) => entry.kind === 'work-merged') ?? false, false);
});

test('delivery waits for another chat working in the same checkout', async () => {
  const other = createEmptyChatObject('model', 'C:/repo');
  other.id = 'other-chat'; other.worktreeRoot = 'C:/worktree';
  sessionState!.chats.push(other);
  setChatRunActivity(other.id, 'running');
  click('Work'); await flush();
  assert.match(document.body.textContent!, /A chat is working in this checkout/);
  assert.equal([...document.querySelectorAll('button')].some((node) => node.textContent?.trim() === 'Commit & merge'), false);
  assert.equal(calls.some((entry) => entry.action === 'Merge'), false);
});
