import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions';
import type { SessionState } from '../../src/types';

test('Graphite surface mounts, moves the same live node and restores each thread', async () => {
  const win = new Window({ url: 'http://localhost' });
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    HTMLElement: win.HTMLElement,
    MutationObserver: win.MutationObserver,
  });
  document.body.innerHTML = `
    <main id="workspaceSplit">
      <header id="graphiteThreadHeader"></header>
      <section id="mainColumn"><textarea id="msgInput"></textarea></section>
    </main>
    <section id="mobile"></section>`;
  const stage = document.getElementById('workspaceSplit')!;
  Object.defineProperty(stage, 'getClientRects', { value: () => [{}] });
  const first = createEmptyChatObject('fixture', '/workspace');
  const second = createEmptyChatObject('fixture', '/workspace');
  const sessions: SessionState = { version: 6, activeId: first.id, sidebarCollapsed: false, chats: [first, second] };
  setSessionStateForTests(sessions);
  const {
    mountSurfacePanels, mountMobileSurfacePortal, mountSurfacePanelToggles, moveActiveSurface,
    openSurface, registerSurface, refreshSurfacePanels,
  } = await import('../../src/ui/surfaces/surfaces-column');

  const preview = document.createElement('article');
  preview.dataset.resource = 'preview-instance';
  const terminal = document.createElement('article');
  terminal.dataset.resource = 'pty-instance';
  registerSurface('preview', { render: () => preview });
  registerSurface('terminal', { render: () => terminal });
  registerSurface('agents', {
    render: () => null,
    availability: () => ({ available: false, reason: 'No subagents yet' }),
  });
  mountSurfacePanels(stage);
  mountSurfacePanelToggles(document.getElementById('graphiteThreadHeader')!);
  const side = document.getElementById('surfaceSide')!;
  const bottom = document.getElementById('surfaceBottom')!;
  assert.equal(side.hidden, true);
  assert.equal(bottom.hidden, true);

  document.getElementById('btnSurfaceSide')!.click();
  assert.equal(side.hidden, false);
  assert.equal(side.querySelector('[role="menuitem"][aria-description="No subagents yet"]')?.getAttribute('aria-disabled'), 'true');
  assert.equal(openSurface('agents'), false);
  document.getElementById('msgInput')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'b', bubbles: true }));
  assert.equal(side.querySelector('[aria-selected="true"]'), null);
  side.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'b', bubbles: true }));
  assert.equal(side.querySelector('[data-resource="preview-instance"]'), preview);
  assert.equal(openSurface('terminal'), true);
  assert.equal(bottom.querySelector('[data-resource="pty-instance"]'), terminal);

  moveActiveSurface('bottom');
  assert.equal(side.querySelector('[data-resource="pty-instance"]'), terminal);
  assert.equal(bottom.hidden, true);
  side.querySelector<HTMLElement>('[aria-label="Maximize"]')!.click();
  assert.equal(stage.dataset.surfaceMax, 'side');
  side.querySelector<HTMLElement>('[aria-label="Restore"]')!.click();
  assert.equal(stage.dataset.surfaceMax, '');
  const separator = side.querySelector<HTMLElement>('[role="separator"]')!;
  separator.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(separator.getAttribute('aria-valuenow'), '456');

  sessions.activeId = second.id;
  refreshSurfacePanels();
  await Promise.resolve();
  assert.equal(side.hidden, true);
  assert.equal(bottom.hidden, true);
  sessions.activeId = first.id;
  refreshSurfacePanels();
  await Promise.resolve();
  assert.equal(side.querySelector('[aria-selected="true"]')?.textContent, 'Terminal');
  assert.equal(side.querySelector('[data-resource="pty-instance"]'), terminal);

  const archive = document.getElementById('mainColumn')!;
  archive.classList.add('graphite-archive-open');
  refreshSurfacePanels();
  await Promise.resolve();
  assert.equal(side.hidden, true);
  assert.equal(openSurface('preview'), false);
  archive.classList.remove('graphite-archive-open');
  refreshSurfacePanels();
  await Promise.resolve();
  assert.equal(side.querySelector('[aria-selected="true"]')?.textContent, 'Terminal');

  archive.classList.add('graphite-new-thread');
  refreshSurfacePanels();
  await Promise.resolve();
  assert.equal(side.hidden, true);
  assert.equal(bottom.hidden, true);
  archive.classList.remove('graphite-new-thread');
  refreshSurfacePanels();
  await Promise.resolve();
  assert.equal(side.querySelector('[data-resource="pty-instance"]'), terminal);

  const mobileHost = document.getElementById('mobile')!;
  const unmount = mountMobileSurfacePortal(mobileHost, second.id);
  assert.equal(openSurface('preview'), true);
  assert.equal(mobileHost.querySelector('[data-resource="preview-instance"]'), preview);
  assert.equal(side.getAttribute('aria-modal'), 'true');
  unmount();
  await Promise.resolve();
  assert.equal(side.parentElement, stage);
  assert.equal(side.querySelector('[aria-selected="true"]')?.textContent, 'Terminal');
  assert.equal(side.getAttribute('aria-modal'), null);

  setSessionStateForTests(null);
  await win.close();
});
