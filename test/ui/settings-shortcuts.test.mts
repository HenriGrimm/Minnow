import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Window } from 'happy-dom';

test('Settings records, cancels, disables, resets and preserves conflicting bindings on cancel', async () => {
  const w = new Window({ url: 'http://localhost' });
  const names = ['window', 'document', 'Element', 'KeyboardEvent', 'navigator'] as const;
  const before = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: w[name] });
  let confirm = false;
  mock.module('../../src/ui/app-dialog.ts', { namedExports: { appConfirm: async () => confirm } });
  const { renderShortcutSettings, disposeShortcutSettings } = await import('../../src/ui/settings-shortcuts.ts');
  const { installInputBindings, getInputBindingStore, inputLabel, keyInput } = await import('../../src/ui/input-bindings.ts');
  const cleanup = installInputBindings();
  const store = getInputBindingStore();
  try {
    const mount = w.document.createElement('div'); w.document.body.append(mount);
    renderShortcutSettings(mount as unknown as HTMLElement);
    const search = mount.querySelector('input[type="search"]')! as any;
    const filter = (value: string) => { search.value = value; search.dispatchEvent(new w.Event('input')); };
    const press = (name: string) => mount.dispatchEvent(new w.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    const buttons = () => [...mount.querySelectorAll('.shortcut-settings__row button')] as any[];
    filter('Ctrl + K'); assert.equal(buttons().length, 3);
    buttons()[0].click(); press('Escape'); assert.equal(store.bindings.length, 0);
    confirm = true;
    buttons()[0].click(); press('F8');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.bindings.length, 1);
    assert.equal(inputLabel(store.bindings[0].input), 'F8');
    assert.equal(store.bindings[0].inText, true, 'modified shortcuts remain usable in the editor');
    // A reused keyboard input warns; cancellation preserves both bindings.
    confirm = false;
    filter('Ctrl + M'); buttons()[0].click(); press('F8');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.bindings.length, 1);
    confirm = true;
    buttons()[0].click(); press('F8');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.bindings.length, 2);
    assert.equal(store.bindings.find((r) => r.target.key === 'k')?.input, null);
    assert.equal(inputLabel(store.bindings.find((r) => r.target.key === 'm')!.input), 'F8');
    buttons()[1].click(); assert.equal(store.bindings.find((r) => r.target.key === 'm')?.input, null);
    buttons()[2].click(); assert.equal(store.bindings.some((r) => r.target.key === 'm'), false);
    // Explicit Escape assignment is available without losing cancel behavior.
    buttons()[0].click();
    ([...mount.querySelectorAll('button')].find((b) => b.textContent === 'Use Escape') as any).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(inputLabel(store.bindings.find((r) => r.target.key === 'm')!.input), 'Escape');
    const original = [...store.bindings];
    buttons()[0].click(); disposeShortcutSettings(); press('F9');
    assert.deepEqual(store.bindings, original);
    // Modified and unmodified keys use the same persisted identity as the runtime.
    assert.equal(keyInput({ key: 'K', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }).key, 'k');
  } finally {
    disposeShortcutSettings(); cleanup(); mock.restoreAll(); await w.happyDOM.close();
    for (const name of names) { const descriptor = before.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  }
});
