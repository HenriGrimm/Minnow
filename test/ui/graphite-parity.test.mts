import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { APPS } from '../../src/os/app-registry';
import { SURFACES } from '../../src/ui/surfaces/surface-registry';

test('Graphite keeps the stable Code control and live surface mount IDs unique', () => {
  const win = new Window();
  try {
    win.document.body.innerHTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const ids = [
      'chatSidebar', 'chatSidebarMain', 'chatList', 'codeViews', 'graphiteThreadHeader',
      'msgInput', 'sendBtn', 'composerPermissionAnchor', 'composerThinkingWrap',
      'composerReasoningEffortSelect', 'contextUsageRing', 'orchestratePlanSelect',
      'workAgentSelect', 'btnViewModeToggleBoard', 'btnComposerOverflow', 'composerRunStatus',
      'terminalPanel', 'fileSidebar', 'fileViewerPane', 'fileViewerPaneSecondary',
      'previewPane', 'previewPaneSecondary', 'btnAgentBrowserViewer', 'btnGitPanelToggle',
      'btnIssuesPanelToggle', 'btnTerminal', 'btnStats',
    ];
    for (const id of ids) assert.equal(win.document.querySelectorAll(`#${id}`).length, 1, id);
    const sidebar = win.document.getElementById('chatSidebarMain')!;
    assert.equal(sidebar.querySelector('button'), null);
    assert.equal(sidebar.firstElementChild?.nextElementSibling?.id, 'chatList');
  } finally {
    win.close();
  }
});

test('Graphite keeps the launcher key order and excludes release-gated apps', () => {
  assert.deepEqual(SURFACES.map(({ id, key }) => [id, key]), [
    ['changes', 'D'], ['terminal', 'T'], ['files', 'F'], ['preview', 'B'],
    ['agents', 'A'], ['pr', 'P'], ['issue', 'I'], ['side', 'S'],
  ]);
  for (const id of ['compare', 'bench', 'experts', 'research']) {
    assert.equal(APPS.find(app => app.id === id)?.releaseState, 'hidden', id);
  }
});
