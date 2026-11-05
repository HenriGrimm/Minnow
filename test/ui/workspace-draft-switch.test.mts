import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { resetAppDialogForTests } from '../../src/ui/app-dialog.ts';
import { getViewerTab, openViewerTab, resetViewerTabStoreForTests, snapshotViewerTabEditorContent } from '../../src/ui/file-viewer-tab-store.ts';
import { executeWorkspaceSwitch, setV2WorkspaceSwitchDepsForTests } from '../../src/ui/workspace-switch-guard.ts';

const source = '/source';
const destination = '/destination';
let win: Window;
let switches: string[];
let writes: string[];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  switches = [];
  writes = [];
  win = new Window();
  installHappyDomGlobals(win, { fetch: async (input, init) => {
    if (input === '/api/workspace' && init?.method === 'PUT') {
      writes.push(String(init.body));
      return Response.json({ path: destination, label: 'destination', isDefault: false });
    }
    return new Response('{}', { status: 503 });
  } });
  setWorkspaceFromServer({ path: source, label: 'source', isDefault: false });
  setV2WorkspaceSwitchDepsForTests({ listBoards: async () => [] });
  window.minnow = { window: { switchWorkspace: async (path: string) => {
    switches.push(path);
    return { ok: true };
  } } } as typeof window.minnow;
});

afterEach(() => {
  resetAppDialogForTests();
  resetViewerTabStoreForTests();
  resetWorkspaceStateForTests();
  setV2WorkspaceSwitchDepsForTests(null);
  globalThis.fetch = originalFetch;
  win.close();
});

async function choice(action: string, message: RegExp) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const dialog = document.querySelector('#appDialogOverlay:not([hidden])');
    const button = dialog?.querySelector<HTMLButtonElement>(`[data-dialog-action="${action}"]`);
    if (button && message.test(dialog?.textContent ?? '')) { button.click(); return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Missing ${action} dialog for ${message}: ${document.body.textContent}`);
}

test('cancel retains inactive and secondary drafts, including a pending discard', async () => {
  await openViewerTab('one.ts', { content: 'one' });
  snapshotViewerTabEditorContent('one.ts', 'draft one', true);
  await openViewerTab('two.ts', { content: 'two' });
  const { registerSecondaryEditorSnapshot } = await import('../../src/ui/file-viewer.ts');
  registerSecondaryEditorSnapshot(() => snapshotViewerTabEditorContent('two.ts', 'draft two', true));
  try {
    assert.equal((await executeWorkspaceSwitch(source))?.path, source);
    const pending = executeWorkspaceSwitch(destination);
    await choice('discard', /one\.ts/);
    await choice('cancel', /two\.ts/);
    assert.equal(await pending, null);
    assert.equal(getViewerTab('one.ts')?.cachedEditorContent, 'draft one');
    assert.equal(getViewerTab('two.ts')?.cachedEditorContent, 'draft two');
    assert.deepEqual(writes, []);
    assert.deepEqual(switches, []);
  } finally {
    registerSecondaryEditorSnapshot(null);
  }
});

test('a failed save leaves both the window binding and cold-boot default intact', async () => {
  await openViewerTab('save.ts', { content: 'base' });
  snapshotViewerTabEditorContent('save.ts', 'unsaved', true);
  const pending = executeWorkspaceSwitch(destination);
  await choice('save', /save\.ts/);
  await choice('ok', /Notice/);
  assert.equal(await pending, null);
  assert.deepEqual(writes, []);
  assert.deepEqual(switches, []);
  assert.equal(getViewerTab('save.ts')?.isDirty, true);
});

test('explicit discard allows a single retarget and leaves its running board alone', async () => {
  let stopped = false;
  setV2WorkspaceSwitchDepsForTests({
    listBoards: async () => [{ boardId: 'board', name: 'Board', status: 'running', planPath: 'p.md', concurrency: 1, taskCount: 1, finished: false }],
    stopBoard: async () => { stopped = true; },
  });
  await openViewerTab('file.ts', { content: 'base' });
  snapshotViewerTabEditorContent('file.ts', 'unsaved', true);
  const pending = executeWorkspaceSwitch(destination);
  assert.equal(await executeWorkspaceSwitch('/another'), null);
  await choice('confirm', /keep running/);
  await choice('discard', /file\.ts/);
  assert.equal((await pending)?.path, destination);
  assert.equal(writes.length, 1);
  assert.deepEqual(switches, [destination]);
  assert.equal(stopped, false);
});
