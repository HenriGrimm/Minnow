/**
 * Settings → Issues must paint before the issues store hydrates (MIN-660)
 * and recover from a failed GitHub import without wedging the shell.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import {
  getIssuesGithubAuto,
  getIssuesGithubDeleteBehavior,
  resetIssuesGithubForTests,
  setIssuesGithubAuto,
  setIssuesGithubDeleteBehavior,
  setIssuesGithubMode,
} from '../../src/state/issues-github.ts';
import { setIssuesStateForTests } from '../../src/state/issues-store.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';

const originalFetch = globalThis.fetch;

let domWindow: Window | null = null;

function setupDom(): HTMLElement {
  const window = new Window({ url: 'http://localhost/' });
  domWindow = window;
  globalThis.window = window as unknown as Window & typeof globalThis.window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Element = window.Element;
  globalThis.SVGElement = window.SVGElement;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  }) as typeof requestAnimationFrame;

  document.body.innerHTML = `
    <span id="sDot"></span>
    <span id="sText"></span>
    <span id="osStatusDot"></span>
    <span id="osStatusText"></span>
    <div id="settingsIssuesBody"></div>
  `;
  const mount = document.getElementById('settingsIssuesBody');
  assert.ok(mount);
  return mount;
}

function statusPillText(): string {
  return `${document.getElementById('sText')?.textContent ?? ''} ${
    document.getElementById('osStatusText')?.textContent ?? ''
  }`;
}

function importButton(root: ParentNode): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((node) =>
    (node.textContent ?? '').includes('Import issues from GitHub'),
  );
  assert.ok(btn);
  return btn as HTMLButtonElement;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('timed out waiting for condition');
}

beforeEach(() => {
  setStorageModeForTests('localStorage');
  setLocalServerAvailableForTests(true);
  resetIssuesGithubForTests();
  setIssuesGithubMode('mirror');
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
  resetIssuesGithubForTests();
  setStorageModeForTests(null);
  setLocalServerAvailableForTests(false);
  const { resetAppDialogForTests } = await import('../../src/ui/app-dialog.ts');
  resetAppDialogForTests();
  domWindow?.close();
  domWindow = null;
});

describe('Settings → Issues GitHub import', () => {
  test('renders without throwing when the issues store is not loaded', async () => {
    const mount = setupDom();
    setIssuesStateForTests(null);
    // Keep boot from hydrating so first paint stays on the unloaded path.
    setStorageModeForTests('server');
    globalThis.fetch = () => new Promise(() => {});

    const { renderIssuesSettingsSection } = await import('../../src/ui/settings-issues.ts');
    assert.doesNotThrow(() => renderIssuesSettingsSection(mount));

    assert.doesNotMatch(statusPillText(), /issuesState is not initialized/);
    assert.doesNotMatch(mount.textContent ?? '', /issuesState is not initialized/);
    assert.match(mount.textContent ?? '', /Import issues from GitHub/);
    assert.equal(importButton(mount).disabled, true);
    const preview = mount.querySelector('.settings-issues-id-preview');
    assert.equal(preview?.textContent, '—');
  });

  test('GitHub panel lists Off and Two-way mirror only', async () => {
    const mount = setupDom();
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    const { renderIssuesSettingsSection } = await import('../../src/ui/settings-issues.ts');
    renderIssuesSettingsSection(mount);

    const select = mount.querySelector('#settingsIssuesGithubMode');
    assert.ok(select);
    const labels = [...select.querySelectorAll('option')].map((option) => option.textContent);
    assert.deepEqual(labels, ['Off', 'Two-way mirror']);
    assert.doesNotMatch(mount.textContent ?? '', /Link \+ push/);
    assert.match(mount.textContent ?? '', /land in Triage/);
    assert.match(mount.textContent ?? '', /Sync automatically/);
    assert.match(mount.textContent ?? '', /Ask before deleting linked issues/);
    assert.equal(importButton(mount).className, 'settings-action-btn');
    const auto = mount.querySelector('#settingsIssuesGithubAuto') as HTMLInputElement | null;
    assert.ok(auto);
    assert.equal(auto.disabled, false);
  });

  test('GitHub deletion prompt toggle restores asking after a remembered choice', async () => {
    const mount = setupDom();
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    setIssuesGithubDeleteBehavior('github');
    const { renderIssuesSettingsSection } = await import('../../src/ui/settings-issues.ts');
    renderIssuesSettingsSection(mount);

    const toggle = mount.querySelector('#settingsIssuesGithubDeletePrompt') as HTMLInputElement | null;
    assert.ok(toggle);
    assert.equal(toggle.checked, false);
    assert.match(mount.textContent ?? '', /remembered choice: Delete everywhere/);

    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(getIssuesGithubDeleteBehavior(), 'ask');
  });

  test('Sync automatically stays checked but disabled when mode is Off', async () => {
    const mount = setupDom();
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    setIssuesGithubAuto(true);
    setIssuesGithubMode('off');
    const { renderIssuesSettingsSection } = await import('../../src/ui/settings-issues.ts');
    renderIssuesSettingsSection(mount);

    const auto = mount.querySelector('#settingsIssuesGithubAuto') as HTMLInputElement | null;
    assert.ok(auto);
    assert.equal(auto.checked, true);
    assert.equal(auto.disabled, true);
    assert.equal(getIssuesGithubAuto(), true);
  });

  test('failed fetch shows Open or restart Minnow and re-enables Import', async () => {
    const mount = setupDom();
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    const { renderIssuesSettingsSection } = await import('../../src/ui/settings-issues.ts');
    renderIssuesSettingsSection(mount);

    const btn = importButton(mount);
    assert.equal(btn.disabled, false);
    btn.click();

    await waitFor(() => Boolean(document.querySelector('[data-dialog-action="ok"]')));
    const dialogText = document.body.textContent ?? '';
    assert.match(dialogText, /Open or restart Minnow and try again/);
    assert.doesNotMatch(dialogText, /server[_ ]off/i);

    document.querySelector<HTMLButtonElement>('[data-dialog-action="ok"]')?.click();
    await waitFor(() => btn.disabled === false);
    assert.doesNotMatch(statusPillText(), /issuesState is not initialized/);
  });
});
