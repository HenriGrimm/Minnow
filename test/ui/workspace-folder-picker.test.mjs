import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function flushAnimationFrames() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

function setupDom() {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLDivElement = window.HTMLDivElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.HTMLUListElement = window.HTMLUListElement;
  globalThis.HTMLOListElement = window.HTMLOListElement;
  globalThis.Node = window.Node;
  globalThis.requestAnimationFrame = (cb) => window.requestAnimationFrame(cb);
  document.body.innerHTML = '<span id="sDot"></span><span id="sText"></span>';

  const browseDir = '/projects/parent';
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.includes('/api/workspace/browse')) {
      const q = new URL(path, 'http://127.0.0.1').searchParams.get('path') ?? '';
      if (!q) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            path: '',
            parent: null,
            entries: [{ name: 'parent', path: browseDir }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          path: browseDir,
          parent: '',
          entries: [],
        }),
      };
    }
    if (path.includes('/api/workspace/mkdir') && init?.method === 'POST') {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          path: `${body.parentPath}/${body.name}`,
          name: body.name,
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  return window;
}

const {
  isWorkspaceFolderPickerOpen,
  openWorkspaceFolderPicker,
  resetWorkspaceFolderPickerForTests,
} = await import('../../src/ui/workspace-folder-picker.ts');

/** Stand in for the Electron preload bridge; returns the paths it was asked to close. */
function installMinnowWindowApi(openWindows) {
  const closed = [];
  globalThis.window.minnow = {
    window: {
      listWorkspaceWindows: async () => openWindows,
      closeWorkspace: async (path) => {
        closed.push(path);
        return { ok: true, closed: true };
      },
    },
  };
  return closed;
}

describe('workspace-folder-picker', { concurrency: false }, () => {
  // A folder that already has a window cannot be opened a second time, so the
  // picker has to say so and offer the one action that helps: closing it.
  test('marks a folder that already has a window and closes it from the row', async () => {
    setupDom();
    resetWorkspaceFolderPickerForTests();
    const closed = installMinnowWindowApi([
      { windowId: 1, workspacePath: '/projects/parent', visible: true },
    ]);

    void openWorkspaceFolderPicker({ initialPath: '' });
    await flushPromises();

    const row = document.querySelector('.workspace-picker__item[data-open-in-window="true"]');
    assert.ok(row, 'the open folder should be marked');
    assert.equal(row.querySelector('.workspace-picker__open-badge')?.textContent, 'Open');

    row.querySelector('.workspace-picker__close-workspace').click();
    await flushPromises();
    assert.deepEqual(closed, ['/projects/parent']);

    delete globalThis.window.minnow;
    resetWorkspaceFolderPickerForTests();
  });

  test('a backgrounded window is labelled as such, not as plainly open', async () => {
    setupDom();
    resetWorkspaceFolderPickerForTests();
    installMinnowWindowApi([
      { windowId: 2, workspacePath: '/projects/parent', visible: false },
    ]);

    void openWorkspaceFolderPicker({ initialPath: '' });
    await flushPromises();

    const row = document.querySelector('[data-workspace-backgrounded="true"]');
    assert.ok(row);
    assert.equal(row.querySelector('.workspace-picker__open-badge')?.textContent, 'Background');

    delete globalThis.window.minnow;
    resetWorkspaceFolderPickerForTests();
  });

  // Backup and restore borrows this browser to choose an ordinary folder. There
  // the workspace wording and the open-window badges would be wrong.
  test('choosing a plain folder renames the dialog and drops workspace badges', async () => {
    setupDom();
    resetWorkspaceFolderPickerForTests();
    installMinnowWindowApi([
      { windowId: 1, workspacePath: '/projects/parent', visible: true },
    ]);

    void openWorkspaceFolderPicker({
      initialPath: '',
      title: 'Choose backup folder',
      confirmVerb: 'Choose',
      elevated: true,
    });
    await flushPromises();

    assert.equal(document.getElementById('workspaceFolderPickerTitle').textContent, 'Choose backup folder');
    assert.equal(document.querySelector('[data-open-in-window="true"]'), null);
    assert.ok(
      document
        .getElementById('workspaceFolderPickerOverlay')
        .classList.contains('workspace-picker-overlay--elevated'),
    );
    document.querySelector('.workspace-picker__row').click();
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.match(document.querySelector('[data-ws-picker-open]').textContent, /^Choose /);
    resetWorkspaceFolderPickerForTests();

    // The next plain open is a workspace picker again.
    void openWorkspaceFolderPicker({ initialPath: '' });
    await flushPromises();
    assert.equal(document.getElementById('workspaceFolderPickerTitle').textContent, 'Open workspace');
    assert.ok(document.querySelector('[data-open-in-window="true"]'));
    assert.equal(
      document
        .getElementById('workspaceFolderPickerOverlay')
        .classList.contains('workspace-picker-overlay--elevated'),
      false,
    );

    delete globalThis.window.minnow;
    resetWorkspaceFolderPickerForTests();
  });

  test('leaves rows untouched outside Electron', async () => {
    setupDom();
    resetWorkspaceFolderPickerForTests();

    void openWorkspaceFolderPicker({ initialPath: '' });
    await flushPromises();

    assert.equal(document.querySelector('[data-open-in-window="true"]'), null);
    assert.equal(document.querySelector('.workspace-picker__close-workspace'), null);
    resetWorkspaceFolderPickerForTests();
  });

  test('new folder input receives focus and accepts a custom name', async () => {
    const win = setupDom();
    resetWorkspaceFolderPickerForTests();

    const pickerPromise = openWorkspaceFolderPicker({ initialPath: '/projects/parent' });
    await flushPromises();
    assert.equal(isWorkspaceFolderPickerOpen(), true);

    const newFolderBtn = document.querySelector('[data-ws-picker-new-folder]');
    const input = document.querySelector('[data-ws-picker-new-folder-input]');
    assert.ok(newFolderBtn);
    assert.ok(input);

    newFolderBtn.click();
    await flushAnimationFrames();
    assert.equal(document.activeElement, input);
    assert.equal(input.value, 'New folder');

    input.value = 'my-workspace';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.equal(input.value, 'my-workspace');

    document.querySelector('[data-ws-picker-cancel]')?.click();
    const result = await pickerPromise;
    assert.equal(result.cancelled, true);
    resetWorkspaceFolderPickerForTests();
  });

  test('Escape closes new folder panel before dismissing the picker', async () => {
    const win = setupDom();
    resetWorkspaceFolderPickerForTests();

    void openWorkspaceFolderPicker({ initialPath: '/projects/parent' });
    await flushPromises();

    document.querySelector('[data-ws-picker-new-folder]')?.click();
    await flushAnimationFrames();

    const panel = document.querySelector('[data-ws-picker-new-folder-panel]');
    assert.ok(panel);
    assert.equal(panel.hidden, false);

    document.dispatchEvent(
      new win.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );

    assert.equal(panel.hidden, true);
    assert.equal(isWorkspaceFolderPickerOpen(), true);

    document.dispatchEvent(
      new win.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(isWorkspaceFolderPickerOpen(), false);
    resetWorkspaceFolderPickerForTests();
  });

  test('breadcrumb parent navigates with absolute Unix path', async () => {
    setupDom();
    resetWorkspaceFolderPickerForTests();

    const browsedPaths = [];
    const childPath = '/Users/henri/Development/Minnow/project';
    const parentPath = '/Users/henri/Development/Minnow';
    globalThis.fetch = async (url) => {
      const path = String(url);
      if (!path.includes('/api/workspace/browse')) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      const q = new URL(path, 'http://127.0.0.1').searchParams.get('path') ?? '';
      browsedPaths.push(q);
      if (!q) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            path: '',
            parent: null,
            entries: [],
          }),
        };
      }
      if (q === childPath) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            path: childPath,
            parent: parentPath,
            entries: [],
          }),
        };
      }
      if (q === parentPath) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            path: parentPath,
            parent: '/Users/henri',
            entries: [],
          }),
        };
      }
      throw new Error(`unexpected browse path: ${q}`);
    };

    void openWorkspaceFolderPicker({ initialPath: childPath });
    await flushPromises();

    const crumbButtons = [...document.querySelectorAll('.workspace-picker__crumb-btn')];
    const parentCrumb = crumbButtons.find((btn) => btn.title === parentPath);
    assert.ok(parentCrumb, `expected breadcrumb for ${parentPath}`);
    parentCrumb.click();
    await flushPromises();

    assert.ok(
      browsedPaths.includes(parentPath),
      `expected browse of ${parentPath}, got ${browsedPaths.join(', ')}`,
    );
    resetWorkspaceFolderPickerForTests();
  });

  test('reuses existing overlay DOM and still wires listeners after reset', async () => {
    setupDom();
    resetWorkspaceFolderPickerForTests();

    void openWorkspaceFolderPicker({ initialPath: '/projects/parent' });
    await flushPromises();
    const overlay = document.getElementById('workspaceFolderPickerOverlay');
    assert.ok(overlay);

    resetWorkspaceFolderPickerForTests();
    assert.equal(document.getElementById('workspaceFolderPickerOverlay'), null);

    void openWorkspaceFolderPicker({ initialPath: '/projects/parent' });
    await flushPromises();

    document.querySelector('[data-ws-picker-new-folder]')?.click();
    await flushAnimationFrames();
    const input = document.querySelector('[data-ws-picker-new-folder-input]');
    assert.equal(document.activeElement, input);
    resetWorkspaceFolderPickerForTests();
  });
});
