import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from './dom-helpers.mts';
import { launchInstance, resetInstancesForTests } from '../../src/os/instances.ts';
import { CHAT_SIDEBAR_CHANGED_EVENT } from '../../src/ui/layout-events.ts';

test('new-chat shortcut activates New thread and follows the workspace lifecycle', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  win.document.body.innerHTML = `
    <div id="appBody"><aside id="chatSidebar" class="collapsed"></aside></div>
    <div id="osStage"></div>
    <nav id="osAppRail"><div class="mn-os-app-rail__nav"></div></nav>
    <div id="osMenubar"></div>
    <textarea id="msgInput"></textarea>
  `;
  const { initGraphiteWorkspace } = await import('../../src/os/graphite-workspace.ts');
  const rail = win.document.getElementById('osAppRail')!;
  const menubar = win.document.getElementById('osMenubar')!;
  let dispose = initGraphiteWorkspace(rail, menubar);
  let activations = 0;
  const observeNewThread = () => {
    const button = win.document.querySelector('.mn-graphite-thread-new')!;
    // Observe the shared button entry point without loading chat storage.
    button.addEventListener('click', (event) => {
      event.stopImmediatePropagation();
      activations += 1;
    }, true);
    assert.equal(button.getAttribute('aria-keyshortcuts'), 'Control+N Meta+N');
  };
  const composer = win.document.getElementById('msgInput')!;
  const press = (options: KeyboardEventInit = {}) => {
    const event = new win.KeyboardEvent('keydown', {
      key: 'n', ctrlKey: true, bubbles: true, cancelable: true, ...options,
    });
    composer.dispatchEvent(event);
    return event;
  };
  try {
    observeNewThread();
    assert.equal(press().defaultPrevented, false);
    assert.equal(activations, 0);

    launchInstance('code');
    composer.focus();
    assert.equal(press().defaultPrevented, true);
    assert.equal(activations, 1);
    assert.equal(press({ ctrlKey: false, metaKey: true, key: 'N' }).defaultPrevented, true);
    assert.equal(activations, 2);

    for (const options of [
      { ctrlKey: false }, { shiftKey: true }, { altKey: true },
      { isComposing: true }, { key: 'm' },
    ]) assert.equal(press(options).defaultPrevented, false);
    assert.equal(press({ repeat: true }).defaultPrevented, true);
    const claimed = (event: Event) => event.preventDefault();
    composer.addEventListener('keydown', claimed);
    press();
    composer.removeEventListener('keydown', claimed);
    assert.equal(activations, 2);

    win.document.documentElement.classList.add('os-workspace-gate-open');
    assert.equal(press().defaultPrevented, false);
    win.document.documentElement.classList.remove('os-workspace-gate-open');

    launchInstance('settings');
    press();
    assert.equal(activations, 3);

    dispose();
    assert.equal(press().defaultPrevented, false);
    dispose = initGraphiteWorkspace(rail, menubar);
    observeNewThread();
    press();
    assert.equal(activations, 4);
  } finally {
    dispose();
    resetInstancesForTests();
    await win.happyDOM.abort();
    win.close();
  }
});

test('Graphite moves Updates with the workspace actions and leaves the titlebar alone', async () => {
  const win = new Window({ width: 1440, height: 900 });
  installHappyDomGlobals(win);
  win.document.body.innerHTML = `
    <div id="appBody"><aside id="chatSidebar" class="collapsed"></aside></div>
    <div id="osStage"></div>
    <nav id="osAppRail"><div class="mn-os-app-rail__nav"></div></nav>
    <div id="osMenubar">
      <div class="mn-os-mb-left"><span>Minnow</span><button>Hide sidebar</button></div>
      <div class="mn-os-mb-right"><div class="mn-os-workspace-actions">
        <div id="osMenubarUpdateSlot"><button>Updates</button></div>
      </div></div>
    </div>
  `;
  const { initGraphiteWorkspace } = await import('../../src/os/graphite-workspace.ts');
  const dispose = initGraphiteWorkspace(
    document.getElementById('osAppRail')!, document.getElementById('osMenubar')!,
  );
  const slot = document.getElementById('osMenubarUpdateSlot')!;
  const sidebar = document.getElementById('chatSidebar')!;
  const toggle = (open: boolean) => {
    sidebar.classList.toggle('collapsed', !open);
    window.dispatchEvent(new window.Event(CHAT_SIDEBAR_CHANGED_EVENT));
  };
  try {
    launchInstance('code');
    assert.ok(slot.closest('.mn-os-mb-right'));
    toggle(true);
    assert.ok(slot.closest('.mn-graphite-sidebar-footer'));
    assert.equal(document.querySelector('.mn-os-mb-left')?.children.length, 2);
    toggle(false);
    assert.ok(slot.closest('.mn-os-mb-right'));
  } finally {
    dispose();
    resetInstancesForTests();
    await win.happyDOM.abort();
    win.close();
  }
});
