import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { renderChatFromHistory, cancelChatHistoryBackfill } from '../../src/ui/messages.ts';
import { disposeChatWorkView, installChatWorkView } from '../../src/ui/chat-work.ts';
import { setChatView } from '../../src/appearance/chat-view.ts';
import { getTurnPresentedFiles, parsePresentedFiles } from '../../src/chat/presented-files.ts';
import { createPresentedFileCards, downloadPresentedFile, openPresentedFile } from '../../src/ui/presented-file-cards.ts';
import { getMode } from '../../src/chat/modes/registry.ts';
import { defaultToolConfig } from '../../src/config/defaults.ts';
import { saveToolConfig, setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { setWorkspaceFromServer, resetWorkspaceStateForTests } from '../../src/state/workspace.ts';
import { resetViewerTabStoreForTests, getViewerTab } from '../../src/ui/file-viewer-tab-store.ts';
import { resetFilePanelStateForTests } from '../../src/state/file-panel.ts';

let win: Window;
let mount: HTMLElement;
let chat: ReturnType<typeof createEmptyChatObject>;
const originalFetch = globalThis.fetch;
const content = JSON.stringify({ kind: 'presented-files', version: 1, workspaceRoot: 'C:/source-worktree', files: [
  { path: 'plan.md', name: 'plan.md', title: 'Implementation plan', bytes: 1200 },
  { path: 'exports/report.pdf', name: 'report.pdf', title: 'Report.pdf', bytes: 42000 },
] });

beforeEach(() => {
  win = new Window({ url: 'http://localhost:9473' });
  installHappyDomGlobals(win);
  DOMPurify.sanitize = DOMPurify(win as any).sanitize;
  setStorageModeForTests('localStorage');
  resetWorkspaceStateForTests();
  resetFilePanelStateForTests();
  resetViewerTabStoreForTests();
  globalThis.fetch = async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  mount = document.createElement('div');
  mount.id = 'chatArea';
  document.body.appendChild(mount);
  chat = createEmptyChatObject('');
  chat.history = [{ role: 'user', content: 'Show me the files.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'files', type: 'function',
      function: { name: 'present_files', arguments: '{"files":[{"path":"plan.md"}]}' } }] },
    { role: 'tool', tool_call_id: 'files', content },
    { role: 'assistant', content: 'The plan and PDF are ready.' }];
  setSessionStateForTests({ version: 2, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  setChatView('compact');
});
afterEach(() => {
  disposeChatWorkView(mount);
  cancelChatHistoryBackfill();
  setSessionStateForTests(null);
  setStorageModeForTests(null);
  globalThis.fetch = originalFetch;
  resetViewerTabStoreForTests();
  resetFilePanelStateForTests();
  setLocalServerAvailableForTests(false);
  win.close();
});

test('file cards remain outside collapsed activity and reconstruct after chat reload', () => {
  renderChatFromHistory(chat);
  assert.equal(mount.querySelectorAll('.presented-file').length, 2);
  assert.equal(mount.querySelector('.chat-presented-files')?.parentElement, mount);
  assert.ok(mount.querySelector('.tool-call-msg')?.classList.contains('chat-work-hidden'));
  assert.ok(!mount.querySelector('.chat-presented-files')?.classList.contains('chat-work-hidden'));
  assert.equal(mount.querySelectorAll('.presented-file__action').length, 4);
  const files = getTurnPresentedFiles(chat, 1, 3);
  const reloaded = JSON.parse(JSON.stringify(chat));
  reloaded.workspacePath = 'C:/different-workspace';
  renderChatFromHistory(reloaded);
  assert.equal(mount.querySelectorAll('.presented-file').length, 2);
  assert.deepEqual(getTurnPresentedFiles(reloaded, 1, 3), files);
  setChatView('full');
  assert.equal(mount.querySelectorAll('.presented-file').length, 2);
});

test('handoffs appear during a live turn and retain their DOM through streaming updates', () => {
  chat.history.pop();
  renderChatFromHistory(chat);
  installChatWorkView(mount, chat, () => true);
  const card = mount.querySelector('.chat-presented-files');
  assert.ok(card);
  installChatWorkView(mount, chat, () => true);
  assert.equal(mount.querySelector('.chat-presented-files'), card);
});

test('ignores malformed, unsupported and unrelated tool results; escapes model titles', () => {
  assert.deepEqual(parsePresentedFiles('Error: missing file'), []);
  assert.deepEqual(parsePresentedFiles(content.replace('"version":1', '"version":2')), []);
  chat.history[1] = { role: 'assistant', content: null, tool_calls: [{ id: 'files', type: 'function',
    function: { name: 'read_file', arguments: '{}' } }] };
  assert.deepEqual(getTurnPresentedFiles(chat, 1, 3), []);
  const file = parsePresentedFiles(content)[0];
  file.title = '<img src=x onerror=alert(1)>';
  const card = createPresentedFileCards([file])!;
  assert.equal(card.querySelector('img'), null);
  assert.equal(card.querySelector('strong')?.textContent, file.title);
  assert.equal(getMode('plan').toolPolicy.tools?.present_files, 'allow');
});

test('download uses the recorded source workspace and original filename; failures are visible on the card', async () => {
  let requested = '';
  const file = parsePresentedFiles(content)[1];
  globalThis.fetch = async input => {
    requested = String(input);
    return new Response(JSON.stringify({ error: 'File no longer exists' }), { status: 404 });
  };
  await assert.rejects(downloadPresentedFile(file), /File no longer exists/);
  const url = new URL(requested);
  assert.equal(url.searchParams.get('workspaceRoot'), 'C:/source-worktree');
  assert.equal(url.searchParams.get('download'), '1');
  assert.equal(url.searchParams.get('raw'), '1');
  assert.match(url.pathname, /exports\/report.pdf$/);
  const cards = createPresentedFileCards([file])!;
  document.body.appendChild(cards);
  (cards.querySelectorAll('button')[1] as HTMLButtonElement).click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(cards.querySelector('.presented-file__status')?.textContent, 'File no longer exists');
  assert.equal((cards.querySelector('.presented-file__status') as HTMLElement).hidden, false);
  assert.equal((cards.querySelectorAll('button')[1] as HTMLButtonElement).disabled, false);
});

test('Open forwards the original workspace and absolute file to Code without opening files during render', async () => {
  const commands: unknown[] = [];
  (win as any).minnow = { window: { sendCodeCommand: async (command: unknown) => { commands.push(command); return { ok: true }; } } };
  const file = parsePresentedFiles(content)[1];
  createPresentedFileCards([file]);
  assert.equal(commands.length, 0);
  await openPresentedFile(file);
  assert.deepEqual(commands, [{ kind: 'file', workspacePath: 'C:/source-worktree', path: 'C:/source-worktree/exports/report.pdf' }]);
});

test('Download saves a binary blob with the real filename rather than a custom display title', async () => {
  const file = parsePresentedFiles(content)[1];
  file.title = 'Custom report title';
  let captured: Blob | undefined;
  let filename = '';
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = win.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = blob => { captured = blob as Blob; return 'blob:test-download'; };
  URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function () { filename = this.download; };
  globalThis.fetch = async () => new Response(new Uint8Array([0, 255, 128, 1]));
  try {
    await downloadPresentedFile(file);
    assert.equal(filename, 'report.pdf');
    assert.deepEqual([...new Uint8Array(await captured!.arrayBuffer())], [0, 255, 128, 1]);
  } finally {
    win.HTMLAnchorElement.prototype.click = originalClick;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test('browser Open reads from the original file scope after changing workspaces', async () => {
  setWorkspaceFromServer({ path: 'C:/current-project', label: 'Current project', isDefault: false });
  const config = defaultToolConfig();
  config.toolCache = { enabled: false };
  config.enabled.get_file_metadata = true;
  config.permissions.default.get_file_metadata = 'full';
  saveToolConfig(config);
  setLocalServerAvailableForTests(true);
  const calls: Array<{ name: string; workspaceRoot: string }> = [];
  const reads: URL[] = [];
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url.includes('/api/tools') && options?.body) {
      const body = JSON.parse(String(options.body));
      calls.push(body);
      return new Response(JSON.stringify({ result: 'size: 25 bytes' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/api/preview/file/')) {
      reads.push(new URL(url));
      return new Response('# Original workspace plan');
    }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  };
  const file = parsePresentedFiles(content)[0];
  await openPresentedFile(file);
  const absolute = 'C:/source-worktree/plan.md';
  const { ensureViewerTabLoaded } = await import('../../src/ui/file-viewer.ts');
  await ensureViewerTabLoaded(absolute);
  assert.equal(getViewerTab(absolute)?.workspaceRoot, 'C:/source-worktree');
  assert.equal(getViewerTab(absolute)?.originalContent, '# Original workspace plan');
  assert.equal(calls.find(call => call.name === 'get_file_metadata')?.workspaceRoot, 'C:/source-worktree');
  assert.equal(reads[0].searchParams.get('workspaceRoot'), 'C:/source-worktree');
});
