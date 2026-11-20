import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { isPreviewHideHeld, holdPreviewGuestHidden, releasePreviewGuestHidden } from '../../src/ui/preview-electron-visibility.ts';

const {
  dismissAllMemorySavedToasts,
  memorySavedDescription,
  memorySavedPayloadFromTool,
  showMemorySavedToast,
} = await import('../../src/ui/memory-saved-toast.ts');
const { resetToastsForTests } = await import('../../src/ui/toast.ts');

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
    resetToastsForTests();
    document.body.replaceChildren();
  });


  test('cards occlude the preview and teardown leaves independent holds alone', () => {
    holdPreviewGuestHidden();
    try {
      showMemorySavedToast({ title: 'Note', description: 'Saved.', target: { kind: 'page', relPath: 'note.md' } });
      const card = document.querySelector('.mn-toast');
      assert.equal(card.classList.contains('mn-occludes-preview'), true);
      assert.equal(card.getAttribute('data-occluder-kind'), 'notification');
      dismissAllMemorySavedToasts();
      assert.equal(card.isConnected, false);
      assert.equal(isPreviewHideHeld(), true);
    } finally {
      releasePreviewGuestHidden();
    }
    assert.equal(isPreviewHideHeld(), false);
  });

  test('renders the saved memory on the shared card with a Reject action', () => {
    showMemorySavedToast({
      title: 'Editor preference',
      description: 'Use tabs for indentation.',
      target: { kind: 'memory', id: '11111111-1111-1111-1111-111111111111' },
    });

    const card = document.querySelector('.mn-toast');
    assert.ok(card);
    assert.equal(card.querySelector('[role="status"]')?.getAttribute('aria-live'), 'polite');
    assert.equal(card.querySelector('.mn-toast__source')?.textContent, 'Brain');
    assert.equal(card.querySelector('.mn-toast__title')?.textContent, 'Editor preference');
    assert.equal(card.querySelector('.mn-toast__message')?.textContent, 'Use tabs for indentation.');
    assert.equal(card.querySelector('.mn-toast__action--danger')?.textContent, 'Reject');
    assert.match(card.querySelector('.mn-toast__open')?.getAttribute('aria-label') ?? '', /Open memory/);
    assert.ok(card.querySelector('.mn-toast__timer-fill'));
  });

  test('clicking the card opens the saved memory through the injected action', async () => {
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

    document.querySelector('.mn-toast__open')?.click();
    await wait(0);

    assert.equal(openedTitle, 'Project facts');
    assert.equal(document.querySelector('.mn-toast'), null);
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
    assert.equal(document.querySelector('.mn-toast__title')?.textContent, 'Original title');
    document.querySelector('.mn-toast__open')?.click();
    await wait(0);

    assert.deepEqual(openedPayload, {
      title: 'Original title',
      description: 'Original description.',
      target: { kind: 'page', relPath: 'facts/original.md' },
    });
  });

  test('rejects the saved memory and confirms in place', async () => {
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

    document.querySelector('.mn-toast__action--danger')?.click();
    await wait(0);

    assert.equal(rejectedId, '22222222-2222-2222-2222-222222222222');
    const cards = document.querySelectorAll('.mn-toast');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].querySelector('.mn-toast__message')?.textContent, 'Memory rejected');
    assert.equal(cards[0].querySelector('.mn-toast__action'), null);
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

    document.querySelector('.mn-toast__action--danger')?.click();
    await wait(0);

    assert.equal(
      document.querySelector('.mn-toast__error')?.textContent,
      'Could not reject this memory. Try again.',
    );
    assert.equal(document.querySelector('.mn-toast__action--danger')?.disabled, false);
  });

  test('concurrent saves stack as separate cards', () => {
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

    const titles = () => [...document.querySelectorAll('.mn-toast__title')].map((node) => node.textContent);
    assert.deepEqual(titles(), ['First memory', 'Second memory']);
    dismissFirst();
    assert.deepEqual(titles(), ['Second memory']);
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

    assert.equal(document.querySelector('.mn-toast'), null);
  });

  test('parses successful memory_save creations only', () => {
    const created = memorySavedPayloadFromTool(
      'memory_save',
      { title: 'Fixture preference', body: 'Prefer deterministic tests.', kind: 'preference', scope: 'user' },
      'Saved user memory: "Fixture preference" (id: 44444444-4444-4444-4444-444444444444, revision: ' + 'a'.repeat(64) + ').',
    );
    assert.deepEqual(created, {
      title: 'Fixture preference',
      description: 'Prefer deterministic tests.',
      target: { kind: 'record', id: '44444444-4444-4444-4444-444444444444' },
    });
    const project = memorySavedPayloadFromTool(
      'memory_save',
      { title: 'CI runs on Linux', body: 'Use POSIX paths.' },
      'Saved project memory for minnow: "CI runs on Linux" (id: 55555555-5555-5555-5555-555555555555, revision: ' + 'b'.repeat(64) + ').',
    );
    assert.equal(project?.target.kind, 'record');
    // Rejecting an update would delete the earlier memory, so updates get no card.
    assert.equal(memorySavedPayloadFromTool(
      'memory_save',
      { id: '55555555-5555-5555-5555-555555555555', title: 'CI runs on Linux', body: 'x' },
      'Updated project memory "CI runs on Linux" (id: 55555555-5555-5555-5555-555555555555, revision: ' + 'c'.repeat(64) + ').',
    ), null);
    // Retired tool names produce no card.
    assert.equal(memorySavedPayloadFromTool(
      'save_memory',
      { title: 'Old', body: 'old' },
      'Saved memory "Old" (id: 66666666-6666-6666-6666-666666666666) under pages/facts/.',
    ), null);
  });

  test('ignores failed tool saves and sanitizes markdown descriptions', () => {
    assert.equal(
      memorySavedPayloadFromTool(
        'memory_save',
        { title: 'Missing body' },
        'Error: body is required: the claim, why it holds and the evidence.',
      ),
      null,
    );
    assert.equal(
      memorySavedDescription('## Preference\nUse **plain** [links](https://example.com).'),
      'Preference Use plain links.',
    );
  });
});
