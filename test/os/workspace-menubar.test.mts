import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { launchInstance, resetInstancesForTests } = await import('../../src/os/instances.ts');
const {
  isWorkspaceInMenubar,
  mountWorkspaceToMenubar,
  syncWorkspaceMenubarPlacement,
  unmountWorkspaceFromMenubar,
} = await import('../../src/os/workspace-menubar.ts');

function setupDom(): void {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;

  const menubar = document.createElement('div');
  menubar.id = 'osMenubar';
  const center = document.createElement('div');
  center.id = 'osMenubarCenter';
  const menubarSlot = document.createElement('div');
  menubarSlot.id = 'osMenubarWorkspaceSlot';
  menubarSlot.hidden = true;
  center.appendChild(menubarSlot);
  menubar.appendChild(center);
  document.body.appendChild(menubar);

  const topbarActions = document.createElement('div');
  topbarActions.className = 'topbar-actions';
  const homeSlot = document.createElement('div');
  homeSlot.id = 'workspaceControlSlot';
  const control = document.createElement('div');
  control.className = 'workspace-control';
  const label = document.createElement('span');
  label.id = 'workspacePathLabel';
  const btn = document.createElement('button');
  btn.id = 'btnWorkspace';
  control.append(label, btn);
  homeSlot.appendChild(control);
  topbarActions.appendChild(homeSlot);
  document.body.appendChild(topbarActions);
}

describe('workspace-menubar', () => {
  afterEach(() => {
    resetInstancesForTests();
    document.body.replaceChildren();
  });

  test('mount moves workspace control into menubar slot', () => {
    setupDom();
    launchInstance('code');
    mountWorkspaceToMenubar();
    const control = document.querySelector('.workspace-control');
    const menubarSlot = document.getElementById('osMenubarWorkspaceSlot');
    assert.ok(control && menubarSlot);
    assert.equal(control.parentElement, menubarSlot);
    assert.equal(menubarSlot.hidden, false);
    assert.equal(isWorkspaceInMenubar(), true);
    assert.ok(control.classList.contains('is-in-menubar'));
  });

  test('mounts in the menubar for non-Code apps too', () => {
    setupDom();
    launchInstance('settings');
    syncWorkspaceMenubarPlacement();
    assert.equal(isWorkspaceInMenubar(), true);
  });

  test('unmount returns workspace control to top bar slot', () => {
    setupDom();
    launchInstance('code');
    mountWorkspaceToMenubar();
    unmountWorkspaceFromMenubar();
    const control = document.querySelector('.workspace-control');
    const homeSlot = document.getElementById('workspaceControlSlot');
    const menubarSlot = document.getElementById('osMenubarWorkspaceSlot');
    assert.ok(control && homeSlot && menubarSlot);
    assert.equal(control.parentElement, homeSlot);
    assert.equal(menubarSlot.hidden, true);
    assert.equal(isWorkspaceInMenubar(), false);
    assert.equal(control.classList.contains('is-in-menubar'), false);
  });
});
