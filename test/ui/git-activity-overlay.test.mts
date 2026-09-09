import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Window } from 'happy-dom';

import { resetChromePopoverRegistryForTests } from '../../src/ui/preview-electron-visibility.ts';

function setupDom() {
  const window = new Window();
  globalThis.window = window as unknown as typeof globalThis.window;
  globalThis.document = window.document as unknown as Document;
  globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof requestAnimationFrame;
}

describe('git activity overlay', () => {
  afterEach(async () => {
    const { resetGitActivityOverlayForTests } = await import(
      '../../src/ui/git-activity-overlay.ts'
    );
    resetGitActivityOverlayForTests();
    resetChromePopoverRegistryForTests();
    document.body.replaceChildren();
  });

  it('shows a bouncing progress card after begin with no delay', async () => {
    setupDom();
    const { beginGitActivity } = await import('../../src/ui/git-activity-overlay.ts');
    beginGitActivity('Pushing…', { delayMs: 0 });

    const card = document.querySelector('.mn-git-activity');
    assert.ok(card);
    assert.equal(card.getAttribute('role'), 'status');
    assert.equal(card.querySelector('.mn-git-activity__label')?.textContent, 'Pushing…');
    assert.ok(card.querySelector('.mn-git-activity__bar-fill'));
    assert.ok(card.classList.contains('mn-git-activity--visible'));
  });

  it('removes the overlay on success and does not leave an error card', async () => {
    setupDom();
    const {
      beginGitActivity,
      finishGitActivitySuccess,
    } = await import('../../src/ui/git-activity-overlay.ts');
    const handle = beginGitActivity('Committing…', { delayMs: 0 });
    finishGitActivitySuccess(handle, 'Committed');

    const card = document.querySelector('.mn-git-activity');
    assert.ok(card);
    assert.equal(card.classList.contains('mn-git-activity--visible'), false);
    assert.equal(card.classList.contains('mn-git-activity--error'), false);
  });

  it('opens a parsed error popover with Send to chat', async () => {
    setupDom();
    const { showGitErrorPopover } = await import('../../src/ui/git-activity-overlay.ts');
    showGitErrorPopover({
      error: '! [rejected] main -> main (non-fast-forward)',
      chatKind: 'push',
      ctx: { branch: 'main' },
    });

    const card = document.querySelector('.mn-git-activity.mn-git-activity--error');
    assert.ok(card);
    assert.equal(card.getAttribute('role'), 'alertdialog');
    assert.equal(card.querySelector('.mn-git-activity__title')?.textContent, 'Push rejected');
    assert.match(
      card.querySelector('.mn-git-activity__summary')?.textContent ?? '',
      /Pull or rebase/,
    );
    const send = card.querySelector('.mn-git-activity__button--primary');
    assert.ok(send);
    assert.equal(send.textContent, 'Send to chat');
    assert.ok(card.querySelector('.mn-git-activity__pre')?.textContent?.includes('non-fast-forward'));
  });
});
