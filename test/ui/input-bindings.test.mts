import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { InputBindingStore, INPUT_BINDINGS_KEY, keyInput, inputId, inputLabel, parseBindings, resolveInput, gamepadEdges } from '../../src/ui/input-bindings.ts';
import { shortcutCatalog } from '../../src/ui/shortcut-catalog.ts';

const key = (name: string, ctrl = false) => keyInput({ key: name, ctrlKey: ctrl, metaKey: false, altKey: false, shiftKey: false });
test('durable bindings validate data and keep old state when writes fail', () => {
  let value: string | null = null;
  let fail = false;
  const storage = { getItem: () => value, setItem: (_: string, v: string) => { if (fail) throw Error('disk full'); value = v; } };
  const store = new InputBindingStore(storage);
  const binding = { target: key('k', true), input: key('F8'), inText: false };
  store.save([binding]);
  assert.deepEqual(new InputBindingStore(storage).bindings, [binding]);
  fail = true;
  assert.throws(() => store.save([]), /disk full/);
  assert.deepEqual(store.bindings, [binding]);
  assert.throws(() => parseBindings(JSON.stringify([binding, binding])), /Duplicate/);
  assert.throws(() => parseBindings('[{"target":{}}]'), /Invalid/);
  value = '{corrupt'; store.reload();
  assert.ok(store.error); assert.deepEqual(store.bindings, []);
});
test('custom input wins over defaults; old keys are disabled without swallowing typing', () => {
  const bindings = [{ target: key('s'), input: key('F8'), inText: false }];
  assert.deepEqual(resolveInput(bindings, key('F8'), false), key('s'));
  assert.equal(resolveInput(bindings, key('s'), false), null);
  assert.equal(resolveInput(bindings, key('s'), true), undefined);
  assert.equal(resolveInput(bindings, key('F8'), true), undefined);
  bindings[0].inText = true;
  assert.deepEqual(resolveInput(bindings, key('F8'), true), key('s'));
  assert.equal(resolveInput(bindings, key('s'), true), null);
  assert.equal(resolveInput([{ target: key('k', true), input: null, inText: false }], key('k', true), true), null);
});
test('catalog targets are unique, cover major surfaces and retain physical Ctrl/Cmd', () => {
  const catalog = shortcutCatalog();
  assert.equal(new Set(catalog.map((r) => inputId(r.target))).size, catalog.length);
  for (const name of ['Shell', 'Chat', 'Code', 'Editor', 'Issues', 'Files', 'Navigation']) assert.ok(catalog.some((r) => r.group === name));
  assert.ok(catalog.some((r) => r.target.key === 'k' && r.target.ctrl));
  assert.ok(catalog.some((r) => r.target.key === 'k' && r.target.meta));
  assert.equal(inputLabel({ kind: 'gamepad', control: 'axis', index: 0, direction: -1 }), 'Gamepad axis 0 −');
});
test('gamepad buttons and axes use edges, hysteresis, disconnection and independent pads', () => {
  const held = new Set<string>();
  const pad = (value: number, axis: number, index = 0) => ({ index, buttons: [{ value }], axes: [axis] }) as Gamepad;
  assert.equal(gamepadEdges([pad(1, -1)], held).length, 2);
  assert.equal(gamepadEdges([pad(1, -0.6)], held).length, 0);
  assert.equal(gamepadEdges([pad(0, 0)], held).length, 0);
  assert.equal(gamepadEdges([pad(1, 1), pad(1, 0, 1)], held).length, 3);
  gamepadEdges([], held); assert.equal(held.size, 0);
});
test('window capture translates once, blocks originals, records without effects, and cleans up', async () => {
  const w = new Window({ url: 'http://localhost' });
  const globals = ['window', 'document', 'Element', 'KeyboardEvent', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const descriptors = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: typeof w[name] === 'function' && name.includes('AnimationFrame') ? w[name].bind(w) : w[name] });
  const { installInputBindings, getInputBindingStore, recordShortcut } = await import('../../src/ui/input-bindings.ts');
  let cleanup: (() => void) | undefined;
  try {
    cleanup = installInputBindings();
    const store = getInputBindingStore();
    const target = w.document.createElement('div'); target.tabIndex = 0; w.document.body.append(target); target.focus();
    const received: string[] = [];
    target.addEventListener('keydown', (e) => received.push(`${e.ctrlKey}:${e.key}`));
    store.save([{ target: key('k', true), input: key('F8'), inText: false }]);
    const send = (name: string, ctrl = false) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: name, code: name, ctrlKey: ctrl, bubbles: true, cancelable: true }));
    send('F8'); assert.deepEqual(received, ['true:k']);
    send('k', true); assert.equal(received.length, 1);
    let recorded = '';
    recordShortcut((input) => { recorded = inputLabel(input); recordShortcut(); });
    send('F9'); assert.equal(recorded, 'F9'); assert.equal(received.length, 1);
    const mouse = { kind: 'mouse', button: 3, ctrl: false, meta: false, alt: false, shift: false } as const;
    store.save([{ target: key('k', true), input: mouse, inText: false }]);
    target.dispatchEvent(new w.PointerEvent('pointerdown', { button: 3, bubbles: true, cancelable: true }));
    assert.equal(received.length, 2);
    let clicked = false; target.onclick = () => { clicked = true; };
    target.dispatchEvent(new w.MouseEvent('auxclick', { button: 3, bubbles: true, cancelable: true }));
    assert.equal(clicked, false);
    store.save([{ target: key('k', true), input: { kind: 'wheel', direction: 'down', ctrl: false, meta: false, alt: false, shift: false }, inText: false }]);
    target.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }));
    assert.equal(received.length, 3);
    // Storage broadcasts update other windows without a reload.
    w.localStorage.setItem(INPUT_BINDINGS_KEY, '[]');
    w.dispatchEvent(new w.StorageEvent('storage', { key: INPUT_BINDINGS_KEY }));
    assert.deepEqual(store.bindings, []);
    cleanup(); cleanup = undefined; send('F8'); assert.equal(received.at(-1), 'false:F8');
  } finally {
    cleanup?.();
    await w.happyDOM.close();
    for (const name of globals) { const descriptor = descriptors.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  }
});
