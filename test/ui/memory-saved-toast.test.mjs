import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { isChromePopoverOpen, registerChromePopover, unregisterChromePopover } from '../../src/ui/preview-electron-visibility.ts';

const {
  dismissAllMemorySavedToasts,
  memorySavedDescription,
  memorySavedPayloadFromTool,
  showMemorySavedToast,
} = await import('../../src/ui/memory-saved-toast.ts');

function setupDom() {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 0;
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

describe('memory saved toast', () => {
  beforeEach(() => {
    setupDom();
  });

  afterEach(() => {
    dismissAllMemorySavedToasts();
    document.body.replaceChildren();
  });


  test('keeps native preview suppressed through exit and queued card transitions', async () => {
    const payload = { title: 'Note', description: 'Saved.', target: { kind: 'page', relPath: 'note.md' } };
    const dismissFirst = showMemorySavedToast(payload);
    showMemorySavedToast({ ...payload, title: 'Next' });
    assert.equal(isChromePopoverOpen(), true);
    dismissFirst();
    document.querySelector('.memory-saved-toast__progress-fill').dispatchEvent(new window.Event('transitionend', { bubbles: true }));
    assert.equal(document.querySelectorAll('.memory-saved-toast').length, 1, 'child progress transition must not end card exit');
    assert.equal(isChromePopoverOpen(), true, 'exiting card still overlays native preview');
    await wait(190);
    assert.equal(document.querySelectorAll('.memory-saved-toast').length, 2);
    const first = document.querySelector('.memory-saved-toast');
    first.dispatchEvent(new window.Event('transitionend'));
    assert.equal(isChromePopoverOpen(), true, 'next card retains its own registration');
    await wait(80);
    assert.equal(isChromePopoverOpen(), true, 'fallback removal cannot unregister twice');
    dismissAllMemorySavedToasts();
    assert.equal(isChromePopoverOpen(), false);
    assert.equal(document.querySelector('.memory-saved-toast'), null);
  });

  test('teardown removes exiting cards and preserves other popover registrations', async () => {
    registerChromePopover();
    const dismiss = showMemorySavedToast({ title: 'Note', description: 'Saved.', target: { kind: 'page', relPath: 'note.md' } });
    dismiss();
    dismissAllMemorySavedToasts();
    assert.equal(document.querySelector('.memory-saved-toast'), null);
    assert.equal(isChromePopoverOpen(), true);
    await wait(270);
    assert.equal(isChromePopoverOpen(), true);
    unregisterChromePopover();
    assert.equal(isChromePopoverOpen(), false);
  });

  test('renders the saved memory title, description, actions, and progress', () => {
    showMemorySavedToast({
      title: 'Editor preference',
      description: 'Use tabs for indentation.',
      target: { kind: 'memory', id: '11111111-1111-1111-1111-111111111111' },
    });

    const card = document.querySelector('.memory-saved-toast');
    assert.ok(card);
    assert.equal(card.getAttribute('role'), 'status');
    assert.equal(card.querySelector('.memory-saved-toast__title')?.textContent, 'Editor preference');
    assert.equal(
      card.querySelector('.memory-saved-toast__description')?.textContent,
      'Use tabs for indentation.',
    );
    assert.equal(card.querySelector('.memory-saved-toast__button--reject')?.textContent, 'Reject');
    assert.equal(card.querySelector('.memory-saved-toast__button--open')?.textContent, 'Open memory');
    const progress = Number(card.style.getPropertyValue('--memory-saved-progress'));
    assert.ok(progress <= 1 && progress > 0.99);
  });

  test('opens the saved memory through the injected action', async () => {
    let openedTitle = '';
    showMemorySavedToast(
      {
        title: 'Project facts',
        description: 'A compact project note.',
        target: { kind: 'page', relPath: 'facts/project.md' },
      },
      {
        onOpen: (payload) => {
          openedTitle = payload.title;
        },
      },
    );

    document.querySelector('.memory-saved-toast__button--open')?.click();
    await wait(0);

    assert.equal(openedTitle, 'Project facts');
  });

  test('snapshots the displayed payload and action target', async () => {
    const payload = {
      title: 'Original title',
      description: 'Original description.',
      target: { kind: 'page', relPath: 'facts/original.md' },
    };
    let openedPayload;
    showMemorySavedToast(payload, {
      onOpen: (opened) => {
        openedPayload = opened;
      },
    });

    payload.title = 'Changed title';
    payload.description = 'Changed description.';
    payload.target.relPath = 'facts/changed.md';
    document.querySelector('.memory-saved-toast__button--open')?.click();
    await wait(0);

    assert.equal(
      document.querySelector('.memory-saved-toast__title')?.textContent,
      'Original title',
    );
    assert.deepEqual(openedPayload, {
      title: 'Original title',
      description: 'Original description.',
      target: { kind: 'page', relPath: 'facts/original.md' },
    });
  });

  test('rejects the saved memory through the injected action', async () => {
    let rejectedId = '';
    showMemorySavedToast(
      {
        title: 'Temporary fact',
        description: 'This fact should be removed.',
        target: { kind: 'memory', id: '22222222-2222-2222-2222-222222222222' },
      },
      {
        onReject: (payload) => {
          rejectedId = payload.target.kind === 'memory' ? payload.target.id : '';
          return true;
        },
      },
    );

    document.querySelector('.memory-saved-toast__button--reject')?.click();
    await wait(0);

    assert.equal(rejectedId, '22222222-2222-2222-2222-222222222222');
    assert.equal(document.querySelector('.memory-saved-toast--visible'), null);
  });

  test('keeps a failed rejection visible with a useful error', async () => {
    showMemorySavedToast(
      {
        title: 'Durable fact',
        description: 'The server will reject this delete.',
        target: { kind: 'memory', id: '33333333-3333-3333-3333-333333333333' },
      },
      { onReject: () => false },
    );

    document.querySelector('.memory-saved-toast__button--reject')?.click();
    await wait(0);

    assert.equal(
      document.querySelector('.memory-saved-toast__error')?.textContent,
      'Could not reject this memory. Try again.',
    );
    assert.equal(
      document.querySelector('.memory-saved-toast__button--reject')?.disabled,
      false,
    );
  });

  test('queues concurrent saves and shows each card in order', async () => {
    const dismissFirst = showMemorySavedToast({
      title: 'First memory',
      description: 'First description.',
      target: { kind: 'page', relPath: 'facts/first.md' },
    });
    showMemorySavedToast({
      title: 'Second memory',
      description: 'Second description.',
      target: { kind: 'page', relPath: 'facts/second.md' },
    });

    assert.equal(
      document.querySelector('.memory-saved-toast__title')?.textContent,
      'First memory',
    );

    dismissFirst();
    await wait(200);

    assert.equal(
      document.querySelector('.memory-saved-toast--visible .memory-saved-toast__title')?.textContent,
      'Second memory',
    );
  });

  test('dismisses after the configured grace period', async () => {
    showMemorySavedToast(
      {
        title: 'Expiring memory',
        description: 'Short review window.',
        target: { kind: 'page', relPath: 'facts/expiring.md' },
      },
      { durationMs: 20 },
    );

    await wait(80);

    assert.equal(document.querySelector('.memory-saved-toast--visible'), null);
  });

  test('parses successful save_memory and brain_write_page results', () => {
    const memoryPayload = memorySavedPayloadFromTool(
      'save_memory',
      { title: 'Fixture preference', body: 'Prefer deterministic tests.' },
      'Saved memory "Fixture preference" (id: 44444444-4444-4444-4444-444444444444) under pages/facts/.',
    );
    const pagePayload = memorySavedPayloadFromTool(
      'brain_write_page',
      {
        path: 'projects/minnow.md',
        title: 'Minnow',
        summary: 'Local-first AI workspace.',
        body: 'Long body.',
      },
      'Created wiki page "Minnow" at projects/minnow.md (id: 55555555-5555-5555-5555-555555555555).',
    );

    assert.deepEqual(memoryPayload, {
      title: 'Fixture preference',
      description: 'Prefer deterministic tests.',
      target: { kind: 'memory', id: '44444444-4444-4444-4444-444444444444' },
    });
    assert.deepEqual(pagePayload, {
      title: 'Minnow',
      description: 'Local-first AI workspace.',
      target: { kind: 'page', relPath: 'projects/minnow.md' },
    });
  });

  test('ignores failed tool saves and sanitizes markdown descriptions', () => {
    assert.equal(
      memorySavedPayloadFromTool(
        'save_memory',
        { title: 'Missing body' },
        'Error: body is required.',
      ),
      null,
    );
    assert.equal(
      memorySavedDescription('## Preference\nUse **plain** [links](https://example.com).'),
      'Preference Use plain links.',
    );
  });
});
