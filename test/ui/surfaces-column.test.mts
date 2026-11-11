import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions';
import type { SessionState } from '../../src/types';

test('Graphite panels open before the first message and restore each thread', async () => {
  const win = new Window({ url: 'http://localhost/#/app/code/chat' });
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
      <section id="mainColumn"><div class="input-bar"><textarea id="msgInput"></textarea></div></section>
    </main>
    <section id="mobile"></section>`;
  const stage = document.getElementById('workspaceSplit')!;
  Object.defineProperty(stage, 'getClientRects', { value: () => [{}] });
  Object.defineProperty(stage, 'clientWidth', { value: 1440 });
  const first = createEmptyChatObject('fixture', '/workspace');
  const second = createEmptyChatObject('fixture', '/workspace');
  const sessions: SessionState = { version: 6, activeId: first.id, sidebarCollapsed: false, chats: [first, second] };
  setSessionStateForTests(sessions);
  const {
    dismissSurface, mountSurfacePanels, mountMobileSurfacePortal, moveActiveSurface,
    openSurface, registerSurface, refreshSurfacePanels,
  } = await import('../../src/ui/surfaces/surfaces-column');
  const { mountGraphiteThreadHeader } = await import('../../src/ui/thread-card');
  const { requestGraphiteSurface } = await import('../../src/ui/surfaces/surface-bridge');

  const preview = document.createElement('article');
  preview.dataset.resource = 'preview-instance';
  const terminal = document.createElement('article');
  terminal.dataset.resource = 'pty-instance';
  registerSurface('preview', { render: () => preview });
  registerSurface('terminal', { render: () => terminal });
  const diff = document.createElement('article');
  let diffTarget: unknown;
  let diffStats: { additions: number; deletions: number } | undefined;
  registerSurface('changes', {
    render: () => diff,
    availability: () => diffStats
      ? { available: true, diffStats }
      : { available: false, reason: 'No changes yet' },
    open: ({ target }) => { diffTarget = target; },
  });
  registerSurface('agents', {
    render: () => null,
    availability: () => ({ available: false, reason: 'No subagents yet' }),
  });
  const issues = document.createElement('article');
  registerSurface('issues', { render: () => issues });
  registerSurface('issue', {
    render: () => null,
    availability: () => ({ available: false, reason: 'No linked issue' }),
  });
  mountSurfacePanels(stage);
  mountGraphiteThreadHeader();
  const mainColumn = document.getElementById('mainColumn')!;
  assert.ok(mainColumn.classList.contains('graphite-new-thread'));
  const side = document.getElementById('surfaceSide')!;
  const bottom = document.getElementById('surfaceBottom')!;
  assert.equal(side.hidden, true);
  assert.equal(bottom.hidden, true);

  const sideToggle = document.getElementById('btnSurfaceSide')!;
  const bottomToggle = document.getElementById('btnSurfaceBottom')!;
  assert.equal(sideToggle.closest('[hidden]'), null);
  assert.equal(bottomToggle.closest('[hidden]'), null);
  bottomToggle.click();
  assert.equal(bottom.hidden, false);
  assert.equal(bottomToggle.getAttribute('aria-pressed'), 'true');
  bottomToggle.click();
  assert.equal(bottom.hidden, true);

  sideToggle.click();
  assert.equal(side.hidden, false);
  document.getElementById('msgInput')!.dispatchEvent(new win.KeyboardEvent('keydown', {
    key: 'j', ctrlKey: true, bubbles: true,
  }));
  assert.equal(side.hidden, true);
  sideToggle.click();
  assert.equal(side.hidden, false);
  assert.equal(side.querySelector('[role="menuitem"][aria-description="No subagents yet"]')?.getAttribute('aria-disabled'), 'true');
  assert.equal(openSurface('agents'), false);
  const threadDiff = side.querySelector<HTMLButtonElement>('[aria-label="Diff"]')!;
  assert.equal(threadDiff.getAttribute('aria-disabled'), 'true');
  threadDiff.click();
  assert.equal(diff.isConnected, false);
  side.querySelector<HTMLButtonElement>('[aria-label="Open workspace diff"]')!.click();
  assert.equal(side.contains(diff), true);
  assert.deepEqual(diffTarget, { kind: 'workspace' });
  dismissSurface('changes');
  diffStats = { additions: 183, deletions: 109 };
  refreshSurfacePanels();
  await Promise.resolve();
  const availableDiff = side.querySelector('[aria-label="Diff"]')!;
  assert.equal(availableDiff.getAttribute('aria-description'), 'Inspect changes. 183 added, 109 deleted.');
  assert.equal(availableDiff.querySelector('.graphite-surface-choice-hint')?.textContent, 'Inspect changes');
  assert.equal(availableDiff.querySelector('.graphite-surface-choice-added')?.textContent, '+183');
  assert.equal(availableDiff.querySelector('.graphite-surface-choice-deleted')?.textContent, '−109');
  const linkedIssue = side.querySelector<HTMLButtonElement>('[aria-label="Issue"]')!;
  assert.equal(linkedIssue.getAttribute('aria-disabled'), 'true');
  linkedIssue.click();
  assert.equal(issues.isConnected, false);
  side.querySelector<HTMLButtonElement>('[aria-label="Open issues"]')!.click();
  assert.equal(side.contains(issues), true);
  assert.equal(side.querySelector('[role="tab"][aria-selected="true"]')?.textContent, 'Issues');
  dismissSurface('issues');
  document.getElementById('msgInput')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'b', bubbles: true }));
  assert.equal(side.querySelector('[aria-selected="true"]'), null);
  side.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'b', bubbles: true }));
  assert.equal(side.querySelector('[data-resource="preview-instance"]'), preview);
  assert.equal(requestGraphiteSurface('terminal', 'show'), true);
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

  separator.setPointerCapture = () => {};
  const drag = (type: string, clientX: number) => separator.dispatchEvent(
    new win.PointerEvent(type, { bubbles: true, pointerId: 1, clientX }),
  );
  drag('pointerdown', 984);
  drag('pointermove', 360);
  await new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
  assert.equal(stage.style.getPropertyValue('--mn-graphite-side-size'), '1080px');
  drag('pointerup', 360);
  assert.equal(stage.dataset.surfaceMax, '');
  assert.equal(separator.getAttribute('aria-valuemax'), '1080');

  drag('pointerdown', 360);
  drag('pointerup', 300);
  assert.equal(stage.dataset.surfaceMax, 'side');
  assert.equal(separator.hidden, true);
  assert.equal(side.querySelector('[data-resource="pty-instance"]'), terminal);
  side.querySelector<HTMLElement>('[aria-label="Restore"]')!.click();
  assert.equal(stage.dataset.surfaceMax, '');
  assert.equal(separator.getAttribute('aria-valuenow'), '1080');

  drag('pointerdown', 360);
  drag('pointermove', 500);
  await new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));
  assert.equal(separator.getAttribute('aria-valuenow'), '940');
  drag('pointercancel', 300);
  assert.equal(stage.dataset.surfaceMax, '');
  assert.equal(separator.getAttribute('aria-valuenow'), '1080');

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

  first.history.push({ role: 'user', content: 'Build it' });
  win.dispatchEvent(new win.Event('hashchange'));
  await Promise.resolve();
  assert.equal(mainColumn.classList.contains('graphite-new-thread'), false);
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
