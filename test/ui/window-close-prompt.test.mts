import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { MinnowElectronBridge } from '../../src/electron.d.ts';
import { resetPreviewHideHoldsForTests } from '../../src/ui/preview-electron-visibility.ts';

describe('window close prompt', () => {
  let win: import('happy-dom').Window;
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;

  beforeEach(async () => {
    resetPreviewHideHoldsForTests();
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
    };

    const { resetAppDialogForTests } = await import('../../src/ui/app-dialog.ts');
    resetAppDialogForTests();
  });

  afterEach(async () => {
    resetPreviewHideHoldsForTests();
    const { resetAppDialogForTests } = await import('../../src/ui/app-dialog.ts');
    resetAppDialogForTests();
    globalThis.requestAnimationFrame = prevRaf;
    (globalThis as { document: Document }).document = prevDocument;
    (globalThis as { window: Window }).window = prevWindow;
  });

  test('maps Close workspace to close and ignores remember on cancel', async () => {
    const { showWindowClosePrompt } = await import('../../src/ui/window-close-prompt.ts');
    const resultPromise = showWindowClosePrompt({
      requestId: 'wcp-1-1',
      title: 'Close workspace?',
      heading: 'Close workspace?',
      folder: 'C:\\Users\\dukky\\.minnow\\workspace',
      detail:
        'Keeping it in the background leaves its chats and agents running and reachable from the tray.',
      checkboxLabel: 'Do this every time',
    });
    await Promise.resolve();

    const pathEl = win.document.querySelector('.app-dialog-panel__path');
    assert.equal(pathEl?.textContent, 'C:\\Users\\dukky\\.minnow\\workspace');

    const checkbox = win.document.querySelector<HTMLInputElement>('#appDialogRemember');
    assert.ok(checkbox);
    checkbox.checked = true;

    win.document.querySelector<HTMLButtonElement>('[data-dialog-action="close"]')?.click();
    assert.deepEqual(await resultPromise, { action: 'close', remember: true });

    const cancelPromise = showWindowClosePrompt({
      requestId: 'wcp-1-2',
      title: 'Close workspace?',
      heading: 'Close this window?',
      folder: '',
      detail: 'Keeping it in the background leaves it running and reachable from the tray.',
      checkboxLabel: 'Do this every time',
    });
    await Promise.resolve();
    const remember = win.document.querySelector<HTMLInputElement>('#appDialogRemember');
    assert.ok(remember);
    remember.checked = true;
    win.document.querySelector<HTMLButtonElement>('[data-dialog-action="cancel"]')?.click();
    assert.deepEqual(await cancelPromise, { action: 'cancel', remember: false });
  });
});
