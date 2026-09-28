/**
 * Global command palette and the registry behind it.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import {
  createCommandPalette,
  fuzzyScore,
  initCommandPalette,
  isCommandPaletteOpen,
  openCommandPalette,
  resetCommandPaletteForTests,
} from '../../src/ui/command-palette';
import {
  listCommands,
  registerCommandSource,
  resetCommandRegistryForTests,
  type Command,
} from '../../src/ui/command-registry';

function cmd(id: string, title: string, group = 'Test', extra: Partial<Command> = {}): Command {
  return { id, title, group, run: () => {}, ...extra };
}

describe('fuzzyScore', () => {
  test('prefers a direct substring over a scattered subsequence', () => {
    const direct = fuzzyScore('Cherry-pick', 'pick');
    const scattered = fuzzyScore('Cherry-pick', 'cpk');
    assert.ok(direct >= 0 && scattered >= 0);
    assert.ok(direct < scattered, 'substring matches rank first');
  });

  test('returns -1 when the subsequence is absent', () => {
    assert.equal(fuzzyScore('Cherry-pick', 'zzz'), -1);
  });

  test('an empty query matches everything equally', () => {
    assert.equal(fuzzyScore('Anything', ''), 0);
  });
});

describe('command registry', () => {
  afterEach(() => {
    resetCommandRegistryForTests();
  });

  test('sources are collected in order', () => {
    registerCommandSource('late', () => [cmd('b', 'Beta')], { order: 200 });
    registerCommandSource('early', () => [cmd('a', 'Alpha')], { order: 10 });
    assert.deepEqual(listCommands().map((c) => c.id), ['a', 'b']);
  });

  test('unavailable commands are hidden', () => {
    registerCommandSource('s', () => [
      cmd('on', 'Shown'),
      cmd('off', 'Hidden', 'Test', { available: () => false }),
    ]);
    assert.deepEqual(listCommands().map((c) => c.id), ['on']);
  });

  test('an earlier source shadows a duplicate id from a later one', () => {
    registerCommandSource('specific', () => [cmd('app.issues', 'Embed Issues')], { order: 10 });
    registerCommandSource('generic', () => [cmd('app.issues', 'Go to Issues')], { order: 100 });
    assert.deepEqual(listCommands().map((c) => c.title), ['Embed Issues']);
  });

  test('a throwing source does not empty the palette', () => {
    registerCommandSource('broken', () => {
      throw new Error('boom');
    }, { order: 10 });
    registerCommandSource('fine', () => [cmd('ok', 'Fine')], { order: 20 });
    assert.deepEqual(listCommands().map((c) => c.id), ['ok']);
  });

  test('unregistering removes the source', () => {
    const off = registerCommandSource('temp', () => [cmd('t', 'Temp')]);
    assert.equal(listCommands().length, 1);
    off();
    assert.equal(listCommands().length, 0);
  });
});

describe('command palette', () => {
  const windows: Window[] = [];

  afterEach(() => {
    resetCommandPaletteForTests();
    resetCommandRegistryForTests();
    for (const win of windows.splice(0)) win.close();
  });

  function installDom(): Document {
    const win = new Window({ url: 'https://minnow.local/' });
    windows.push(win);
    (globalThis as { document?: Document }).document = win.document as unknown as Document;
    (globalThis as { window?: Window }).window = win as unknown as Window;
    return win.document as unknown as Document;
  }

  function paletteRows(doc: Document): string[] {
    return [...doc.querySelectorAll('.mn-palette__row .mn-palette__title')].map(
      (n) => n.textContent ?? '',
    );
  }

  test('opens as a modal dialog with combobox semantics', () => {
    const doc = installDom();
    registerCommandSource('s', () => [cmd('a', 'Fetch'), cmd('b', 'Push')]);
    openCommandPalette();

    const dialog = doc.querySelector('.mn-palette');
    assert.equal(dialog?.getAttribute('role'), 'dialog');
    assert.equal(dialog?.getAttribute('aria-modal'), 'true');

    const input = doc.querySelector<HTMLInputElement>('.mn-palette__input');
    assert.equal(input?.getAttribute('role'), 'combobox');
    assert.equal(input?.getAttribute('aria-controls'), 'mnCommandPaletteList');
    assert.equal(doc.querySelector('.mn-palette__list')?.getAttribute('role'), 'listbox');
    assert.deepEqual(paletteRows(doc), ['Fetch', 'Push']);
    assert.equal(isCommandPaletteOpen(), true);
  });

  test('typing filters and re-ranks, and the active row is announced', () => {
    const doc = installDom();
    registerCommandSource('s', () => [
      cmd('a', 'Fetch', 'Remote'),
      cmd('b', 'Push', 'Remote'),
      cmd('c', 'Cherry-pick', 'History'),
    ]);
    openCommandPalette();

    const input = doc.querySelector<HTMLInputElement>('.mn-palette__input');
    assert.ok(input);
    input.value = 'cpk';
    input.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('input', {
      bubbles: true,
    }));

    assert.deepEqual(paletteRows(doc), ['Cherry-pick']);
    const active = doc.querySelector('.mn-palette__row.is-active');
    assert.equal(active?.getAttribute('aria-selected'), 'true');
    assert.equal(input.getAttribute('aria-activedescendant'), active?.id);
  });

  test('a query with no match says so rather than showing an empty box', () => {
    const doc = installDom();
    registerCommandSource('s', () => [cmd('a', 'Fetch')]);
    openCommandPalette();

    const input = doc.querySelector<HTMLInputElement>('.mn-palette__input');
    assert.ok(input);
    input.value = 'zzzz';
    input.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('input', {
      bubbles: true,
    }));

    assert.match(doc.querySelector('.mn-palette__empty')?.textContent ?? '', /No command matches/);
  });

  test('Enter runs the active command and closes, restoring focus', async () => {
    const doc = installDom();
    const opener = doc.createElement('button');
    doc.body.appendChild(opener);
    opener.focus();

    let ran = '';
    registerCommandSource('s', () => [
      cmd('a', 'Fetch', 'Remote', { run: () => { ran = 'fetch'; } }),
      cmd('b', 'Push', 'Remote', { run: () => { ran = 'push'; } }),
    ]);
    openCommandPalette();

    const KeyboardEvent = (doc.defaultView as unknown as typeof globalThis).KeyboardEvent;
    const input = doc.querySelector<HTMLInputElement>('.mn-palette__input');
    assert.ok(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(ran, 'push');
    assert.equal(isCommandPaletteOpen(), false);
    assert.equal(doc.activeElement, opener);
  });

  test('Escape closes without running anything', () => {
    const doc = installDom();
    let ran = 0;
    registerCommandSource('s', () => [cmd('a', 'Fetch', 'Remote', { run: () => { ran += 1; } })]);
    openCommandPalette();

    const KeyboardEvent = (doc.defaultView as unknown as typeof globalThis).KeyboardEvent;
    doc.querySelector<HTMLInputElement>('.mn-palette__input')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    assert.equal(isCommandPaletteOpen(), false);
    assert.equal(ran, 0);
  });

  test('Ctrl+K opens it and toggles it shut', () => {
    const doc = installDom();
    registerCommandSource('s', () => [cmd('a', 'Fetch')]);
    initCommandPalette();

    const KeyboardEvent = (doc.defaultView as unknown as typeof globalThis).KeyboardEvent;
    const chord = () =>
      doc.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }),
      );

    chord();
    assert.equal(isCommandPaletteOpen(), true);
    chord();
    assert.equal(isCommandPaletteOpen(), false);
  });

  test('Ctrl+Shift+P is an equivalent chord', () => {
    const doc = installDom();
    registerCommandSource('s', () => [cmd('a', 'Fetch')]);
    initCommandPalette();

    doc.dispatchEvent(
      new (doc.defaultView as unknown as typeof globalThis).KeyboardEvent('keydown', {
        key: 'P',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(isCommandPaletteOpen(), true);
  });

  test('a chord another handler already claimed is left alone', () => {
    const doc = installDom();
    registerCommandSource('s', () => [cmd('a', 'Fetch')]);
    initCommandPalette();

    // Quick Edit consumes Mod-K in the editor by calling preventDefault.
    doc.addEventListener('keydown', (event) => event.preventDefault(), true);
    doc.dispatchEvent(
      new (doc.defaultView as unknown as typeof globalThis).KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    assert.equal(isCommandPaletteOpen(), false, 'the editor keeps its binding');
  });

  test('an embedded palette keeps its own class prefix and host', () => {
    const doc = installDom();
    const hostEl = doc.createElement('div');
    doc.body.appendChild(hostEl);

    const scoped = createCommandPalette({
      host: hostEl,
      getCommands: () => [cmd('a', 'Rebase')],
      label: 'Source control commands',
      classPrefix: 'scc-palette',
      listId: 'sccPaletteList',
    });
    scoped.open();

    assert.ok(hostEl.querySelector('.scc-palette-overlay'), 'mounted into its own host');
    assert.equal(hostEl.querySelector('.scc-palette__list')?.id, 'sccPaletteList');
    assert.equal(doc.querySelector('.mn-palette'), null, 'no global palette was created');
    scoped.destroy();
  });
});
