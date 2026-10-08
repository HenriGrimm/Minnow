/**
 * Shared context menu: menu semantics, nested submenus, keyboard model.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import {
  closeContextMenu,
  deferUntilContextMenuClosed,
  isContextMenuOpen,
  openContextMenu,
  type MenuItem,
} from '../../src/ui/context-menu';
import {
  buildMenuItems,
  MENU_ORDER,
  registerMenuContributor,
  resetMenuRegistryForTests,
} from '../../src/ui/menu-registry';

describe('shared context menu', () => {
  const windows: Window[] = [];

  afterEach(() => {
    closeContextMenu();
    resetMenuRegistryForTests();
    for (const win of windows.splice(0)) win.close();
  });

  function installDom(): Document {
    const win = new Window({ url: 'https://minnow.local/' });
    windows.push(win);
    (globalThis as { document?: Document }).document = win.document as unknown as Document;
    (globalThis as { window?: Window }).window = win as unknown as Window;
    return win.document as unknown as Document;
  }

  function rows(doc: Document, level = 0): HTMLButtonElement[] {
    const menus = [...doc.querySelectorAll<HTMLElement>('.mn-menu')];
    const menu = menus[level];
    return menu ? [...menu.querySelectorAll<HTMLButtonElement>('.mn-menu__item')] : [];
  }

  function key(doc: Document, name: string): void {
    doc.dispatchEvent(
      new (doc.defaultView as unknown as typeof globalThis).KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  const sample: MenuItem[] = [
    { id: 'open', label: 'Open' },
    { kind: 'separator' },
    {
      kind: 'submenu',
      id: 'status',
      label: 'Change status',
      items: [
        { id: 'todo', label: 'Todo' },
        { id: 'done', label: 'Done' },
      ],
    },
    { id: 'delete', label: 'Delete', danger: true },
  ].map((item) =>
    'kind' in item ? (item as MenuItem) : ({ ...item, onSelect: () => {} } as MenuItem),
  );

  test('renders menu semantics and focuses the first enabled row', () => {
    const doc = installDom();
    openContextMenu({ items: sample, clientX: 40, clientY: 40, label: 'Issue actions' });

    const menu = doc.querySelector('.mn-menu');
    assert.equal(menu?.getAttribute('role'), 'menu');
    assert.equal(menu?.getAttribute('aria-label'), 'Issue actions');
    assert.equal(rows(doc).length, 3);
    assert.equal(doc.activeElement?.textContent?.trim(), 'Open');
  });

  test('coalesces background refreshes until the menu action has completed', async () => {
    const doc = installDom();
    let selected = false;
    const observations: boolean[] = [];
    const refresh = () => observations.push(selected);
    openContextMenu({ items: [{ id: 'choose', label: 'Choose', onSelect: () => { selected = true; } }] });
    assert.equal(deferUntilContextMenuClosed(refresh), true);
    assert.equal(deferUntilContextMenuClosed(refresh), true);
    assert.deepEqual(observations, []);
    rows(doc)[0].click();
    await Promise.resolve();
    assert.deepEqual(observations, [true]);
    assert.equal(deferUntilContextMenuClosed(refresh), false);
  });

  test('opening a replacement menu keeps background refreshes deferred', async () => {
    installDom();
    let refreshes = 0;
    openContextMenu({ items: sample });
    deferUntilContextMenuClosed(() => { refreshes += 1; });
    openContextMenu({ items: sample });
    await Promise.resolve();
    assert.equal(refreshes, 0);
    closeContextMenu();
    await Promise.resolve();
    assert.equal(refreshes, 1);
  });

  test('scrolling an unrelated pane preserves pointer and anchored menus, including submenus', () => {
    const doc = installDom();
    const view = doc.defaultView as unknown as typeof globalThis;
    const issues = doc.createElement('div');
    const opener = doc.createElement('button');
    issues.appendChild(opener);
    const chat = doc.createElement('div');
    doc.body.append(issues, chat);

    for (const origin of [{ restoreFocus: opener }, { anchor: opener }]) {
      const menu = openContextMenu({ items: sample, clientX: 40, clientY: 40, ...origin });
      rows(doc)[1].click();
      const submenu = doc.querySelectorAll('.mn-menu')[1];
      assert.ok(submenu);

      chat.dispatchEvent(new view.Event('scroll'));
      menu.root.dispatchEvent(new view.Event('scroll'));
      submenu.dispatchEvent(new view.Event('scroll'));
      assert.equal(menu.root.isConnected, true);
      assert.equal(submenu.isConnected, true);
    }
  });

  test('scrolling the opener pane or viewport and resizing still dismiss the menu', () => {
    const doc = installDom();
    const view = doc.defaultView as unknown as typeof globalThis;
    const pane = doc.createElement('div');
    const opener = doc.createElement('button');
    pane.appendChild(opener);
    doc.body.appendChild(pane);

    for (const target of [pane, doc, doc.defaultView!]) {
      openContextMenu({ items: sample, restoreFocus: opener });
      target.dispatchEvent(new view.Event('scroll'));
      assert.equal(isContextMenuOpen(), false);
    }

    openContextMenu({ items: sample, anchor: opener });
    doc.defaultView!.dispatchEvent(new view.Event('resize'));
    assert.equal(isContextMenuOpen(), false);
  });

  test('renders a leading Uicons glyph when iconClass is set', () => {
    const doc = installDom();
    openContextMenu({
      items: [
        {
          id: 'todo',
          label: 'Todo',
          iconClass: 'fi-sr-clipboard-list',
          onSelect: () => {},
        },
      ],
      clientX: 10,
      clientY: 10,
    });

    const glyph = rows(doc)[0]?.querySelector('.mn-menu__icon');
    assert.ok(glyph);
    assert.equal(glyph?.classList.contains('fi-sr-clipboard-list'), true);
    assert.equal(glyph?.getAttribute('aria-hidden'), 'true');
  });

  test('a submenu row is marked as such and opens a real nested menu', () => {
    const doc = installDom();
    openContextMenu({ items: sample, clientX: 40, clientY: 40 });

    const submenuRow = rows(doc).find((r) => r.classList.contains('is-submenu'));
    assert.ok(submenuRow, 'submenu row exists');
    assert.equal(submenuRow.getAttribute('aria-haspopup'), 'menu');
    assert.equal(submenuRow.getAttribute('aria-expanded'), 'false');

    submenuRow.click();

    assert.equal(doc.querySelectorAll('.mn-menu').length, 2, 'a second menu is mounted');
    assert.equal(submenuRow.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(
      rows(doc, 1).map((r) => r.textContent?.trim()),
      ['Todo', 'Done'],
    );
  });

  test('ArrowRight opens a submenu and ArrowLeft returns to its parent row', () => {
    const doc = installDom();
    openContextMenu({ items: sample, clientX: 40, clientY: 40 });

    key(doc, 'ArrowDown'); // Open -> Change status
    assert.equal(doc.activeElement?.textContent?.trim(), 'Change status');

    key(doc, 'ArrowRight');
    assert.equal(doc.querySelectorAll('.mn-menu').length, 2);
    assert.equal(doc.activeElement?.textContent?.trim(), 'Todo');

    key(doc, 'ArrowLeft');
    assert.equal(doc.querySelectorAll('.mn-menu').length, 1, 'submenu closes');
    assert.equal(doc.activeElement?.textContent?.trim(), 'Change status');
  });

  test('Escape closes one level at a time, then the whole menu', () => {
    const doc = installDom();
    const opener = doc.createElement('button');
    doc.body.appendChild(opener);
    openContextMenu({ items: sample, clientX: 40, clientY: 40, restoreFocus: opener });

    key(doc, 'ArrowDown');
    key(doc, 'ArrowRight');
    assert.equal(doc.querySelectorAll('.mn-menu').length, 2);

    key(doc, 'Escape');
    assert.equal(doc.querySelectorAll('.mn-menu').length, 1, 'only the submenu closed');

    key(doc, 'Escape');
    assert.equal(isContextMenuOpen(), false);
    assert.equal(doc.activeElement, opener, 'focus returns to the opener');
  });

  test('selecting an action closes the menu and runs it once', () => {
    const doc = installDom();
    let calls = 0;
    openContextMenu({
      items: [{ id: 'go', label: 'Go', onSelect: () => { calls += 1; } }],
      clientX: 10,
      clientY: 10,
    });

    rows(doc)[0].click();
    assert.equal(calls, 1);
    assert.equal(isContextMenuOpen(), false);
  });

  test('arrow navigation skips disabled rows', () => {
    const doc = installDom();
    openContextMenu({
      clientX: 10,
      clientY: 10,
      items: [
        { id: 'a', label: 'Alpha', onSelect: () => {} },
        { id: 'b', label: 'Beta', disabled: true, onSelect: () => {} },
        { id: 'c', label: 'Gamma', onSelect: () => {} },
      ],
    });

    assert.equal(doc.activeElement?.textContent?.trim(), 'Alpha');
    key(doc, 'ArrowDown');
    assert.equal(doc.activeElement?.textContent?.trim(), 'Gamma');
  });

  test('typeahead jumps to the next row starting with the typed letter', () => {
    const doc = installDom();
    openContextMenu({
      clientX: 10,
      clientY: 10,
      items: [
        { id: 'a', label: 'Assign', onSelect: () => {} },
        { id: 'd', label: 'Duplicate', onSelect: () => {} },
        { id: 'r', label: 'Rename', onSelect: () => {} },
      ],
    });

    key(doc, 'r');
    assert.equal(doc.activeElement?.textContent?.trim(), 'Rename');
  });

  test('checkbox rows carry aria-checked', () => {
    const doc = installDom();
    openContextMenu({
      clientX: 10,
      clientY: 10,
      items: [
        { id: 'hide', label: 'Hide done', checked: true, onSelect: () => {} },
        { id: 'sub', label: 'Show sub-issues', checked: false, onSelect: () => {} },
      ],
    });

    const [first, second] = rows(doc);
    assert.equal(first.getAttribute('role'), 'menuitemcheckbox');
    assert.equal(first.getAttribute('aria-checked'), 'true');
    assert.equal(second.getAttribute('aria-checked'), 'false');
  });

  test('a heading opens a labelled group rather than a bare divider', () => {
    const doc = installDom();
    openContextMenu({
      clientX: 10,
      clientY: 10,
      items: [
        { kind: 'heading', label: 'Priority' },
        { id: 'high', label: 'High', onSelect: () => {} },
      ],
    });

    const group = doc.querySelector('.mn-menu__group');
    assert.equal(group?.getAttribute('role'), 'group');
    assert.equal(group?.getAttribute('aria-label'), 'Priority');
  });

  test('empty menus say so instead of rendering a bare box', () => {
    const doc = installDom();
    openContextMenu({ items: [], clientX: 10, clientY: 10 });
    assert.equal(doc.querySelector('.mn-menu__empty')?.textContent, 'No actions available');
  });
});

describe('menu registry', () => {
  afterEach(() => {
    resetMenuRegistryForTests();
  });

  test('contributions are ordered and separated from the surface own rows', () => {
    registerMenuContributor(
      'issues',
      () => [{ id: 'create-issue', label: 'Create issue', onSelect: () => {} }],
      { order: MENU_ORDER.integration },
    );
    registerMenuContributor(
      'clipboard',
      () => [{ id: 'copy-path', label: 'Copy path', onSelect: () => {} }],
      { order: MENU_ORDER.utility },
    );

    const items = buildMenuItems({ kind: 'file', path: 'src/a.ts' }, [
      { id: 'open', label: 'Open', onSelect: () => {} },
    ]);

    assert.deepEqual(
      items.map((i) => ('label' in i ? i.label : i.kind)),
      ['Open', 'separator', 'Create issue', 'separator', 'Copy path'],
    );
  });

  test('contributors only see the target kinds they registered for', () => {
    registerMenuContributor('files-only', () => [
      { id: 'reveal', label: 'Reveal', onSelect: () => {} },
    ], { kinds: ['file'] });

    assert.equal(buildMenuItems({ kind: 'file' }).length, 1);
    assert.equal(buildMenuItems({ kind: 'commit' }).length, 0);
  });

  test('a throwing contributor does not cost the user the rest of the menu', () => {
    registerMenuContributor('broken', () => {
      throw new Error('boom');
    }, { order: 10 });
    registerMenuContributor('fine', () => [
      { id: 'ok', label: 'Still here', onSelect: () => {} },
    ], { order: 20 });

    const items = buildMenuItems({ kind: 'file' });
    assert.deepEqual(items.map((i) => ('label' in i ? i.label : i.kind)), ['Still here']);
  });

  test('re-registering an id replaces it instead of stacking duplicates', () => {
    registerMenuContributor('x', () => [{ id: 'a', label: 'One', onSelect: () => {} }]);
    registerMenuContributor('x', () => [{ id: 'a', label: 'Two', onSelect: () => {} }]);
    const items = buildMenuItems({ kind: 'any' });
    assert.deepEqual(items.map((i) => ('label' in i ? i.label : i.kind)), ['Two']);
  });
});
