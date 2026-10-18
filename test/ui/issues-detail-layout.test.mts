/**
 * Docked peek width clamp/persist and expand-to-sheet chrome.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import type { IssueCard } from '../../src/types.ts';
import { ISSUES_COMPAT_VERSION, ISSUES_SCHEMA_VERSION } from '../../src/types.ts';

const { setIssuesStateForTests } = await import('../../src/state/issues-store.ts');
const { closeIssueDetail, openIssueDetail, refreshIssueDetailIfOpen } = await import(
  '../../src/ui/issues-detail.ts'
);
const { resetIssuesDetailLayoutForTests, isIssueDetailSheetExpanded, setIssueDetailSheetExpanded } = await import('../../src/ui/issues-detail-layout.ts');
const { setIssueDetailNavigation, navigateIssueDetail, getSelectedIssueId } = await import('../../src/ui/issues-detail.ts');
const { resetGhAvailableCache } = await import('../../src/chat/issues/git-actions.ts');
const { resetIssuesGithubForTests, setIssuesGithubMode } = await import(
  '../../src/state/issues-github.ts'
);
const { setLocalServerAvailableForTests, setToolConfigForTests } = await import(
  '../../src/tools/config.ts'
);
const { defaultToolConfig } = await import('../../src/config/defaults.ts');
const { resetWorkspaceStateForTests, setWorkspaceFromServer } = await import(
  '../../src/state/workspace.ts'
);

const FIXED_NOW = 1_710_000_006_000;
const WS_A = 'C:/Users/dukky/Projects/peek-a';
const WS_B = 'C:/Users/dukky/Projects/peek-b';

let domWindow: Window | null = null;

function setupDom(): void {
  const window = new Window({ url: 'http://localhost/' });
  domWindow = window;
  globalThis.window = window as unknown as Window & typeof globalThis.window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Element = window.Element;
  globalThis.localStorage = window.localStorage;
  setLocalServerAvailableForTests(false);
  setToolConfigForTests(defaultToolConfig());
  resetIssuesGithubForTests();
  setIssuesGithubMode('off');
  document.body.innerHTML = `
    <main id="issuesView" class="issues-page">
      <div class="issues-shell">
        <div class="issues-body"></div>
      </div>
    </main>
  `;
}

function seedIssue(): void {
  const issue: IssueCard = {
    id: 'VIN-10',
    type: 'task',
    title: 'test',
    description: 'Goal: native app',
    status: 'backlog',
    priority: 'high',
    labels: [],
    workspacePath: WS_A,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    source: 'user',
  };
  setIssuesStateForTests({
    version: ISSUES_COMPAT_VERSION,
    schemaRevision: ISSUES_SCHEMA_VERSION,
    nextId: 11,
    issues: [issue],
    workspaces: {},
  });
}

afterEach(() => {
  if (domWindow) closeIssueDetail();
  resetIssuesDetailLayoutForTests();
  resetGhAvailableCache();
  resetIssuesGithubForTests();
  setIssuesStateForTests(null);
  resetWorkspaceStateForTests();
  domWindow?.close();
  domWindow = null;
});

describe('floating issue panel', () => {
  test('opens over the list as a dialog, with no dock resizer', () => {
    setupDom(); seedIssue();
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    openIssueDetail('VIN-10');
    const host = document.getElementById('issuesDetailHost')!;
    assert.equal(host.getAttribute('role'), 'dialog');
    assert.equal(host.getAttribute('aria-modal'), 'true');
    assert.equal(document.activeElement, host);
    assert.equal(document.getElementById('issuesDetailResizer'), null);
    assert.equal(document.getElementById('issuesDetailScrim')!.hidden, false);
    assert.ok(document.querySelector('.issues-shell.is-detail-expanded'));
    refreshIssueDetailIfOpen();
    assert.equal(document.getElementById('issuesDetailHost'), host);
    closeIssueDetail();
    assert.equal(document.getElementById('issuesDetailScrim')!.hidden, true);
    assert.equal(document.activeElement, trigger);
  });

  test('maximize stays floating and closing clears maximize state', () => {
    setupDom(); seedIssue(); openIssueDetail('VIN-10');
    setIssueDetailSheetExpanded(true);
    assert.equal(isIssueDetailSheetExpanded(), true);
    assert.ok(document.querySelector('.issues-shell.is-detail-maximized'));
    assert.equal(document.querySelector('.issues-detail__layout-expand')?.getAttribute('aria-label'), 'Restore issue panel size');
    closeIssueDetail(); openIssueDetail('VIN-10');
    assert.equal(isIssueDetailSheetExpanded(), false);
  });

  test('scrim closes the panel rather than restoring a docked view', () => {
    setupDom(); seedIssue(); openIssueDetail('VIN-10');
    (document.getElementById('issuesDetailScrim') as HTMLButtonElement).click();
    assert.equal(getSelectedIssueId(), undefined);
    assert.equal(document.querySelector('.issues-detail-host.is-open'), null);
  });

  test('navigation honors supplied list order, endpoints and editor flush', () => {
    setupDom(); seedIssue();
    const { issues } = { issues: ['VIN-10', 'VIN-11', 'VIN-12'].map((id) => ({
      id, type: 'task', title: id, description: 'Original description', status: 'backlog', priority: 'none', labels: [],
      workspacePath: WS_A, createdAt: FIXED_NOW, updatedAt: FIXED_NOW, source: 'user',
    } as IssueCard)) };
    setIssuesStateForTests({ version: ISSUES_COMPAT_VERSION, schemaRevision: ISSUES_SCHEMA_VERSION, nextId: 13, issues, workspaces: {} });
    setIssueDetailNavigation({ issueIds: () => ['VIN-12', 'VIN-10', 'VIN-12'], onNavigate: openIssueDetail });
    openIssueDetail('VIN-12');
    assert.equal(document.querySelector<HTMLButtonElement>('[data-issue-step="-1"]')!.disabled, true);
    assert.equal(document.querySelector('.issues-detail__position')!.textContent, '1 / 2');
    const editor = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
    assert.ok(editor);
    editor.querySelector('p')!.textContent = 'Edited before navigation';
    assert.equal(navigateIssueDetail(1), true);
    assert.equal(getSelectedIssueId(), 'VIN-10');
    assert.equal(document.querySelector<HTMLButtonElement>('[data-issue-step="1"]')!.disabled, true);
    assert.equal(navigateIssueDetail(1), false);
    navigateIssueDetail(-1);
    assert.match(document.querySelector('.mn-editor')!.textContent!, /Edited before navigation/);
    openIssueDetail('VIN-11');
    assert.equal(navigateIssueDetail(1), false, 'issues outside the visible list have no adjacent issue');
  });
});
