import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { setIssuesStateForTests, updateIssue } from '../../src/state/issues-store';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions';
import { openIssuesEmbeddedInCode, renderIssuesPanel, teardownIssuesEmbedBeforeChatPaint } from '../../src/ui/issues-page';
import { closeContextMenu, openContextMenu } from '../../src/ui/context-menu';
import { closeIssuesLabelsSuggestionsMenu } from '../../src/ui/issues-labels-field';
import { initMenubarCapture } from '../../src/os/menubar-capture';

test('Issues preserves copy shortcuts and open menus during background refreshes', async () => {
  const win = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, {
    window: win, document: win.document, HTMLElement: win.HTMLElement,
    Node: win.Node, SVGElement: win.SVGElement, Element: win.Element,
    HTMLInputElement: win.HTMLInputElement, HTMLSelectElement: win.HTMLSelectElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLButtonElement: win.HTMLButtonElement,
    getComputedStyle: win.getComputedStyle.bind(win),
  });
  document.body.innerHTML = `
    <div id="osAppsLayer"><main id="issuesView" class="issues-page"></main></div>
    <div id="mainColumn"><div id="chatArea"></div></div>
    <button id="capture"></button>`;
  const chat = createEmptyChatObject('test-model');
  setSessionStateForTests({ version: 3, activeId: chat.id, chats: [chat], sidebarCollapsed: false });
  setIssuesStateForTests({
    version: 2,
    nextId: 2,
    issues: [{
      id: 'MIN-1', type: 'task', title: 'Keep label popover open', description: '',
      status: 'todo', priority: 'none', labels: [], workspacePath: '',
      createdAt: 1, updatedAt: 1, source: 'user',
    }],
    workspaces: {},
  });
  const cleanupCapture = initMenubarCapture(document.getElementById('capture') as HTMLButtonElement);
  try {
    await openIssuesEmbeddedInCode();
    const issueRow = document.querySelector<HTMLElement>('.issues-row');
    assert.ok(issueRow);
    issueRow.dispatchEvent(new win.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    }));
    assert.ok(document.querySelector('.mn-menu__item[data-id="send-to-chat"]'));
    assert.equal(document.querySelector('.mn-menu__item[data-id="send-to-background"]'), null);
    closeContextMenu();

    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const copy = new win.KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ...modifier, bubbles: true, cancelable: true });
      document.body.dispatchEvent(copy);
      assert.equal(copy.defaultPrevented, false, 'standard copy must reach the browser');
      assert.equal(document.getElementById('issuesNewForm')?.classList.contains('is-open'), false);
    }

    const mount = document.getElementById('issuesPanelMount')!;
    const originalContent = mount.firstElementChild;
    const menu = openContextMenu({ items: [{ id: 'choose', label: 'Choose', onSelect() {} }] });
    updateIssue('MIN-1', { title: 'Keep label popover open (edited)' });
    renderIssuesPanel();
    renderIssuesPanel();
    assert.equal(menu.root.isConnected, true, 'refresh must not dismiss the menu');
    assert.equal(mount.firstElementChild, originalContent, 'menu anchors must remain mounted');
    closeContextMenu();
    await Promise.resolve();
    assert.notEqual(mount.firstElementChild, originalContent, 'deferred refresh lands on dismissal');

    const addLabel = mount.querySelector<HTMLButtonElement>('.issues-labels-field__add');
    assert.ok(addLabel);
    addLabel.click();
    const labelInput = document.querySelector<HTMLInputElement>('.issues-labels-add-popover input');
    assert.ok(labelInput);
    labelInput.value = 'typed';
    labelInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    renderIssuesPanel();
    renderIssuesPanel();
    assert.equal(labelInput.isConnected, true, 'refresh must not dismiss the label popover');
    assert.equal(labelInput.value, 'typed', 'refresh must preserve label input');
    closeIssuesLabelsSuggestionsMenu();
    await Promise.resolve();
    assert.equal(labelInput.isConnected, false, 'deferred refresh lands after popover dismissal');

    const pressedRow = mount.querySelector<HTMLElement>('.issues-row');
    assert.ok(pressedRow);
    renderIssuesPanel();
    assert.equal(pressedRow.isConnected, true, 'a refresh with nothing new keeps the row');
    pressedRow.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    updateIssue('MIN-1', { title: 'Edited while pressed' });
    renderIssuesPanel();
    assert.equal(pressedRow.isConnected, true, 'refresh must not replace the row being clicked');
    pressedRow.dispatchEvent(new win.PointerEvent('pointerup', { bubbles: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pressedRow.isConnected, false, 'held refresh lands after the click');

    const capture = new win.KeyboardEvent('keydown', { key: 'i', code: 'KeyI', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(capture);
    assert.equal(capture.defaultPrevented, true, 'Ctrl+I opens quick capture');
    document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    const editing = new win.KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(editing);
    assert.equal(editing.defaultPrevented, false, 'text editor shortcuts remain available');
  } finally {
    cleanupCapture();
    closeContextMenu();
    closeIssuesLabelsSuggestionsMenu();
    await Promise.resolve();
    teardownIssuesEmbedBeforeChatPaint();
    setSessionStateForTests(null);
    win.close();
  }
});
