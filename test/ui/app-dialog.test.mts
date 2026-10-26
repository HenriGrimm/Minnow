import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { MinnowElectronBridge } from '../../src/electron.d.ts';

describe('app dialog', () => {
  let win: import('happy-dom').Window;
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;

  beforeEach(async () => {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof requestAnimationFrame;

    const { Window } = await import('happy-dom');
    win = new Window();
    (globalThis as { document: Document }).document = win.document as unknown as Document;
    (globalThis as { window: Window }).window = win as unknown as Window & typeof globalThis.window;

    (win as unknown as { minnow: MinnowElectronBridge }).minnow = {
      preview: {
        show: async () => {},
        hide: async () => {},
      } as MinnowElectronBridge['preview'],
      app: {
        isElectron: true,
        platform: 'win32',
        openExternal: async () => {},
      },
      window: {
        minimize: async () => {},
        maximize: async () => {},
        close: async () => {},
        isMaximized: async () => false,
        onMaximizedChanged: () => () => {},
      },
    };

    const { resetAppDialogForTests } = await import('../../src/ui/app-dialog.ts');
    resetAppDialogForTests();
  });

  afterEach(async () => {
    const { resetAppDialogForTests } = await import('../../src/ui/app-dialog.ts');
    resetAppDialogForTests();
    globalThis.requestAnimationFrame = prevRaf;
    (globalThis as { document: Document }).document = prevDocument;
    (globalThis as { window: Window }).window = prevWindow;
  });

  test('installAppDialogs replaces native dialog functions in Electron', async () => {
    win.alert = () => {};
    win.confirm = () => true;
    win.prompt = () => null;
    const nativeConfirm = win.confirm;
    const { installAppDialogs } = await import('../../src/ui/app-dialog.ts');
    installAppDialogs(win as unknown as Window);
    assert.notEqual(win.confirm, nativeConfirm);
  });

  test('appConfirm resolves true when confirmed', async () => {
    const { appConfirm, isAppDialogOpen } = await import('../../src/ui/app-dialog.ts');
    const resultPromise = appConfirm('Delete branch?');
    await Promise.resolve();

    assert.equal(isAppDialogOpen(), true);
    const confirmBtn = win.document.querySelector<HTMLButtonElement>(
      '[data-dialog-action="confirm"]',
    );
    assert.ok(confirmBtn);
    confirmBtn.click();

    assert.equal(await resultPromise, true);
    assert.equal(isAppDialogOpen(), false);
  });

  test('appConfirm resolves false when cancelled', async () => {
    const { appConfirm } = await import('../../src/ui/app-dialog.ts');
    const resultPromise = appConfirm('Discard changes?');
    await Promise.resolve();

    const cancelBtn = win.document.querySelector<HTMLButtonElement>(
      '[data-dialog-action="cancel"]',
    );
    assert.ok(cancelBtn);
    cancelBtn.click();

    assert.equal(await resultPromise, false);
  });

  test('appChoice returns the clicked action and checkbox', async () => {
    const { appChoice, isAppDialogOpen } = await import('../../src/ui/app-dialog.ts');
    const resultPromise = appChoice({
      title: 'Close workspace?',
      message: 'Close minnow?',
      checkboxLabel: 'Do this every time',
      defaultFocusId: 'background',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'close', label: 'Close workspace', danger: true },
        { id: 'background', label: 'Keep in background', primary: true },
      ],
    });
    await Promise.resolve();

    assert.equal(isAppDialogOpen(), true);
    const checkbox = win.document.querySelector<HTMLInputElement>('#appDialogRemember');
    assert.ok(checkbox);
    checkbox.checked = true;
    const keepBtn = win.document.querySelector<HTMLButtonElement>(
      '[data-dialog-action="background"]',
    );
    assert.ok(keepBtn);
    assert.equal(keepBtn.classList.contains('app-dialog-panel__btn--primary'), true);
    const closeBtn = win.document.querySelector<HTMLButtonElement>(
      '[data-dialog-action="close"]',
    );
    assert.ok(closeBtn);
    assert.equal(closeBtn.classList.contains('app-dialog-panel__btn--danger'), true);
    keepBtn.click();

    assert.deepEqual(await resultPromise, { id: 'background', checkboxChecked: true });
    assert.equal(isAppDialogOpen(), false);
  });

  test('appChoice Escape maps to cancelId', async () => {
    const { appChoice } = await import('../../src/ui/app-dialog.ts');
    const resultPromise = appChoice({
      message: 'Close this window?',
      cancelId: 'cancel',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'close', label: 'Close workspace', danger: true },
      ],
    });
    await Promise.resolve();

    win.document.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    assert.deepEqual(await resultPromise, { id: 'cancel', checkboxChecked: false });
  });
});
