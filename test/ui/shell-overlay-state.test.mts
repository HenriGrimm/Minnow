import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  bindShellOverlayTrigger, closeShellOverlay, isShellOverlayOpen,
  openShellOverlay, shellOverlayClosed,
} from '../../src/ui/shell-overlay-state.ts';

let win: Window;
let dispose: Array<() => void>;
beforeEach(() => {
  win = new Window();
  dispose = [];
  win.document.body.innerHTML = '<button id="settings"></button><button id="settingsRail"></button><button id="wiki"></button><button id="workspace"></button><section id="settingsView"><input></section><section id="productWikiOverlay"></section><section id="osWorkspaceGate"></section>';
});
afterEach(() => {
  closeShellOverlay();
  dispose.forEach((fn) => fn());
  win.close();
});
function button(id: string, overlay = id): HTMLElement {
  const btn = win.document.getElementById(id)!;
  dispose.push(bindShellOverlayTrigger(btn, overlay));
  return btn;
}
function assertState(btn: HTMLElement, open: boolean): void {
  assert.equal(btn.getAttribute('aria-expanded'), String(open));
  assert.equal(btn.getAttribute('aria-pressed'), String(open));
  assert.equal(btn.classList.contains('is-overlay-open'), open);
}

test('all controls for a surface reflect lifecycle state, including late bindings', () => {
  const header = button('settings');
  assertState(header, false);
  openShellOverlay('settings', () => shellOverlayClosed('settings'));
  const rail = button('settingsRail', 'settings');
  assertState(header, true);
  assertState(rail, true);
  shellOverlayClosed('settings');
  assertState(header, false);
  assertState(rail, false);
});

test('opening a different overlay closes the previous before publishing the next', () => {
  const settings = button('settings');
  const wiki = button('wiki');
  let closed = 0;
  openShellOverlay('settings', () => { closed++; shellOverlayClosed('settings'); });
  openShellOverlay('wiki', () => shellOverlayClosed('wiki'));
  assert.equal(closed, 1);
  assertState(settings, false);
  assertState(wiki, true);
  shellOverlayClosed('settings'); // A late close cannot clear the new overlay.
  assertState(wiki, true);
  closeShellOverlay();
  assertState(wiki, false);
});

test('a nav trigger can toggle without outside-pointer dismissal reopening it', () => {
  const workspace = button('workspace');
  workspace.addEventListener('click', () => {
    if (isShellOverlayOpen('workspace')) closeShellOverlay();
    else openShellOverlay('workspace', () => shellOverlayClosed('workspace'));
  });
  workspace.click();
  workspace.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  assertState(workspace, true);
  workspace.click();
  assertState(workspace, false);
});

test('Escape dismisses and returns focus; inside clicks do not dismiss, outside does', () => {
  const wiki = button('wiki');
  openShellOverlay('wiki', () => shellOverlayClosed('wiki'));
  win.document.getElementById('productWikiOverlay')!.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  assertState(wiki, true);
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assertState(wiki, false);
  assert.equal(win.document.activeElement, wiki);
  openShellOverlay('wiki', () => shellOverlayClosed('wiki'));
  win.document.body.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  assertState(wiki, false);
});

test('handled Escape leaves a nested control in charge', () => {
  const settings = button('settings');
  openShellOverlay('settings', () => shellOverlayClosed('settings'));
  const event = new win.KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
  event.preventDefault();
  win.document.dispatchEvent(event);
  assertState(settings, true);
});

test('dialogs and prompts layered above an open overlay do not dismiss it', () => {
  button('settings');
  let closed = 0;
  openShellOverlay('settings', () => { closed++; shellOverlayClosed('settings'); });
  const layer = win.document.createElement('div');
  layer.dataset.aboveShellOverlay = '';
  const confirm = win.document.createElement('button');
  layer.append(confirm);
  win.document.body.append(layer);
  confirm.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  assert.equal(closed, 0);
  assert.equal(isShellOverlayOpen('settings'), true);
  win.document.body.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  assert.equal(closed, 1);
});
