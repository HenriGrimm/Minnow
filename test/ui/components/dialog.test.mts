/**
 * Shared dialog: ARIA, focus management, dismissal, actions, stacking.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { closeAllDialogs, isDialogOpen, openDialog } from '../../../src/ui/components/dialog';
import { resetTooltipForTests } from '../../../src/ui/components/tooltip';
import { installComponentDom, type ComponentDom } from './component-dom.mts';

describe('dialog', () => {
  let dom: ComponentDom;

  afterEach(() => {
    closeAllDialogs();
    resetTooltipForTests();
    dom?.cleanup();
  });

  function setupOpener(): HTMLButtonElement {
    dom = installComponentDom();
    const opener = dom.doc.createElement('button');
    opener.textContent = 'Delete…';
    dom.doc.body.appendChild(opener);
    opener.focus();
    return opener;
  }

  test('labels itself and focuses the autoFocus action; closing restores focus', async () => {
    const opener = setupOpener();
    const handle = openDialog({
      title: 'Delete branch?',
      description: 'This removes the local branch.',
      actions: [
        { id: 'cancel', label: 'Cancel', autoFocus: true },
        { id: 'delete', label: 'Delete', variant: 'danger' },
      ],
    });
    const { panel } = handle;
    assert.equal(panel.getAttribute('role'), 'dialog');
    assert.equal(panel.getAttribute('aria-modal'), 'true');
    assert.equal(dom.doc.getElementById(panel.getAttribute('aria-labelledby')!)?.textContent, 'Delete branch?');
    assert.equal(
      dom.doc.getElementById(panel.getAttribute('aria-describedby')!)?.textContent,
      'This removes the local branch.',
    );
    assert.equal(handle.overlay.classList.contains('mn-occludes-preview'), true);
    const active = dom.doc.activeElement as HTMLElement;
    assert.equal(active.dataset.dialogAction, 'cancel');

    handle.footer.querySelector<HTMLButtonElement>('[data-dialog-action="delete"]')!.click();
    assert.equal(await handle.closed, 'delete');
    assert.equal(handle.overlay.isConnected, false);
    assert.equal(dom.doc.activeElement === opener, true);
    assert.equal(isDialogOpen(), false);
  });

  test('Escape and the scrim dismiss with null', async () => {
    setupOpener();
    const first = openDialog({ title: 'One', body: 'Text' });
    dom.key(first.panel, 'Escape');
    assert.equal(await first.closed, null);

    const second = openDialog({ title: 'Two', body: 'Text' });
    dom.pointer(second.overlay, 'pointerdown');
    second.overlay.dispatchEvent(new dom.win.MouseEvent('click', { bubbles: true }) as unknown as Event);
    assert.equal(await second.closed, null);
  });

  test('a press that starts inside the panel never dismisses via the scrim', () => {
    setupOpener();
    const handle = openDialog({ title: 'Keep', body: 'Text' });
    dom.pointer(handle.panel, 'pointerdown');
    handle.overlay.dispatchEvent(new dom.win.MouseEvent('click', { bubbles: true }) as unknown as Event);
    assert.equal(isDialogOpen(), true);
  });

  test('non-dismissible dialogs ignore Escape and have no close button', () => {
    setupOpener();
    const handle = openDialog({ title: 'Working', body: 'Text', dismissible: false, actions: [{ id: 'ok', label: 'OK' }] });
    assert.equal(handle.panel.querySelector('.mn-dialog__close'), null);
    dom.key(handle.panel, 'Escape');
    assert.equal(isDialogOpen(), true);
  });

  test('an action returning false keeps it open; an async action shows busy state', async () => {
    setupOpener();
    let release!: () => void;
    const handle = openDialog({
      title: 'Save',
      actions: [
        { id: 'check', label: 'Check', run: () => false },
        { id: 'save', label: 'Save', variant: 'primary', run: () => new Promise<void>((resolve) => (release = resolve)) },
      ],
    });
    const check = handle.footer.querySelector<HTMLButtonElement>('[data-dialog-action="check"]')!;
    const save = handle.footer.querySelector<HTMLButtonElement>('[data-dialog-action="save"]')!;
    check.click();
    assert.equal(isDialogOpen(), true);

    save.click();
    assert.equal(save.getAttribute('aria-busy'), 'true');
    assert.equal(check.disabled, true);
    release();
    assert.equal(await handle.closed, 'save');
  });

  test('with two dialogs open, Escape closes only the top one and Tab stays inside it', async () => {
    setupOpener();
    const lower = openDialog({ title: 'Lower', body: 'Text', actions: [{ id: 'ok', label: 'OK' }] });
    const upper = openDialog({
      title: 'Upper',
      body: 'Text',
      actions: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    });
    const buttons = [...upper.panel.querySelectorAll<HTMLButtonElement>('button')];
    buttons[buttons.length - 1].focus();
    const tab = dom.key(buttons[buttons.length - 1], 'Tab');
    assert.equal(tab.defaultPrevented, true);
    assert.equal(dom.doc.activeElement === buttons[0], true, 'wrapped to the first control');

    dom.key(upper.panel, 'Escape');
    assert.equal(await upper.closed, null);
    assert.equal(lower.overlay.isConnected, true);
    assert.equal(isDialogOpen(), true);
  });

  test('an empty body and footer are hidden', () => {
    setupOpener();
    const handle = openDialog({ title: 'Only a title' });
    assert.equal(handle.body.hidden, true);
    assert.equal(handle.footer.hidden, true);
    // Nothing to act on: the panel itself takes focus so the dialog is announced.
    assert.equal(dom.doc.activeElement === handle.panel, true);
  });
});
