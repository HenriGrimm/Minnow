import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { themeStep } from '../../src/onboarding/steps/theme.ts';
import { buildOnboardingContext, createDefaultOnboardingState } from '../../src/onboarding/state-core.ts';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup() {
  const win = new Window();
  installHappyDomGlobals(win);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctx = buildOnboardingContext(createDefaultOnboardingState(), {
    serverAvailable: true, configServerAvailable: true,
  });
  const actions = { next() {}, back() {}, skip() {}, patchContext() {},
    setPrimaryEnabled() {}, setPrimaryLabel() {}, stepIndex: 1, totalSteps: 9 };
  return { win, container, ctx, actions };
}

test('appearance zoom loads the saved value, saves immediately, follows shortcuts, and unsubscribes', async () => {
  const { win, container, ctx, actions } = setup();
  let percent = 125;
  let notify: (percent: number) => void = () => {};
  let unsubscribed = false;
  const writes: number[] = [];
  Object.assign(window, { minnow: { app: { isElectron: true }, tray: {
    getZoomPercent: async () => percent,
    setZoomPercent: async (value: number) => { writes.push(value); return percent = value; },
    onZoomPercentChanged: (listener: typeof notify) => { notify = listener; return () => { unsubscribed = true; }; },
  } } });
  const cleanup = themeStep.render(container, ctx, actions);
  try {
    const select = container.querySelector<HTMLSelectElement>('.settings-select')!;
    assert.ok(select);
    assert.equal(select.disabled, true);
    await flush();
    assert.equal(select.value, '125');
    select.value = '150';
    select.dispatchEvent(new win.Event('change'));
    await flush();
    assert.deepEqual(writes, [150]);
    assert.equal(percent, 150);
    notify(175);
    assert.equal(select.value, '175', 'non-preset shortcut zoom must remain visible');
    assert.equal(select.options[select.selectedIndex].textContent, '175%');
    if (typeof cleanup === 'function') cleanup();
    assert.equal(unsubscribed, true);
    notify(200);
    assert.equal(select.value, '175');
  } finally { win.close(); }
});

test('zoom load and save failures are recoverable without advancing setup', async () => {
  const { win, container, ctx, actions } = setup();
  let failRead = true;
  let failWrite = true;
  Object.assign(window, { minnow: { app: { isElectron: true }, tray: {
    getZoomPercent: async () => { if (failRead) throw new Error('offline'); return 110; },
    setZoomPercent: async (value: number) => { if (failWrite) throw new Error('disk'); return value; },
    onZoomPercentChanged: () => () => {},
  } } });
  const cleanup = themeStep.render(container, ctx, actions);
  try {
    await flush();
    const select = container.querySelector<HTMLSelectElement>('.settings-select')!;
    assert.equal(select.disabled, true);
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Could not load/);
    failRead = false;
    container.querySelector<HTMLButtonElement>('.mn-onboarding-appearance-zoom button')!.click();
    await flush();
    assert.equal(select.value, '110');
    select.value = '150';
    select.dispatchEvent(new win.Event('change'));
    await flush();
    assert.equal(select.value, '110');
    assert.equal(select.disabled, false);
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Could not save/);
    failWrite = false;
    select.value = '150';
    select.dispatchEvent(new win.Event('change'));
    await flush();
    assert.equal(select.value, '150');
  } finally { if (typeof cleanup === 'function') cleanup(); win.close(); }
});

test('browser appearance explains browser zoom without offering a nonfunctional desktop control', () => {
  const { win, container, ctx, actions } = setup();
  try {
    themeStep.render(container, ctx, actions);
    assert.equal(container.querySelector('.mn-onboarding-appearance-zoom select'), null);
    assert.match(container.textContent!, /browser’s zoom controls/);
  } finally { win.close(); }
});
