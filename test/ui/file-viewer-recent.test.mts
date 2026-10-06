import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { resetFilePanelStateForTests } from '../../src/state/file-panel.ts';
import { recordRecentViewerFile } from '../../src/state/recent-viewer-files.ts';
import {
  resetWorkspaceStateForTests,
  setWorkspaceFromServer,
} from '../../src/state/workspace.ts';
import { renderViewerRecentFilesEmptyState } from '../../src/ui/file-viewer-recent.ts';

let win: Window | undefined;

function setupDom(): void {
  win = new Window();
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document;
  globalThis.HTMLElement = win.HTMLElement;
  document.body.innerHTML = '<div id="host"></div>';
}

describe('file viewer recent empty state', () => {
  beforeEach(() => {
    resetFilePanelStateForTests();
    resetWorkspaceStateForTests();
    setWorkspaceFromServer({
      path: '/workspace/demo',
      label: 'demo',
      isDefault: false,
    });
    globalThis.fetch = (async () =>
      ({ ok: true, json: async () => ({}) }) as Response) as typeof fetch;
    setupDom();
  });

  afterEach(() => {
    win?.close();
    win = undefined;
  });

  test('renders guidance when there are no recent files', () => {
    const host = document.getElementById('host')!;
    renderViewerRecentFilesEmptyState(host);
    assert.equal(host.querySelector('.file-viewer-recent__title')?.textContent, 'No file open');
    assert.equal(host.querySelector('.file-viewer-recent__list'), null);
    assert.deepEqual(
      Array.from(host.querySelectorAll('.code-readiness-actions button'), (button) => button.textContent),
      ['Browse files', 'Open terminal'],
    );
  });

  test('renders recent rows with open and remove controls', () => {
    recordRecentViewerFile('src/main.ts', {
      workspaceRoot: '/workspace/demo',
      openedAt: 1_700_000_000_000,
    });
    recordRecentViewerFile('readme.md', {
      workspaceRoot: '/workspace/demo',
      openedAt: 1_700_000_100_000,
    });
    const host = document.getElementById('host')!;
    renderViewerRecentFilesEmptyState(host);
    assert.equal(host.querySelector('.file-viewer-recent__title')?.textContent, 'Recent files');
    const opens = host.querySelectorAll('.file-viewer-recent__open');
    assert.equal(opens.length, 2);
    assert.match(opens[0]!.textContent ?? '', /readme\.md/);
    assert.equal(host.querySelectorAll('.file-viewer-recent__remove').length, 2);
    assert.ok(host.querySelector('.file-viewer-recent__clear'));
  });
});
