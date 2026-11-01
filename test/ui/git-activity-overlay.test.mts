import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Window } from 'happy-dom';


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
    const { resetToastsForTests } = await import('../../src/ui/toast.ts');
    resetToastsForTests();
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

  it('shows a parsed error card with Send to chat and details', async () => {
    setupDom();
    const { showGitErrorPopover } = await import('../../src/ui/git-activity-overlay.ts');
    showGitErrorPopover({
      error: '! [rejected] main -> main (non-fast-forward)',
      chatKind: 'push',
      ctx: { branch: 'main' },
    });

    const card = document.querySelector('.mn-toast.mn-toast--error');
    assert.ok(card);
    assert.equal(card.querySelector('[role="alert"]')?.getAttribute('aria-live'), 'assertive');
    assert.equal(card.querySelector('.mn-toast__source')?.textContent, 'Source Control');
    assert.equal(card.querySelector('.mn-toast__context')?.textContent, 'push · main');
    assert.equal(card.querySelector('.mn-toast__title')?.textContent, 'Push rejected');
    assert.match(card.querySelector('.mn-toast__message')?.textContent ?? '', /Pull or rebase/);
    const send = card.querySelector('.mn-toast__action--primary');
    assert.ok(send);
    assert.equal(send.textContent, 'Send to chat');
    assert.ok(card.querySelector('.mn-toast__detail')?.textContent?.includes('non-fast-forward'));
    assert.equal(document.querySelector('.mn-git-activity--visible'), null, 'progress card is gone');
  });

  it('ignores cancelled operations', async () => {
    setupDom();
    const { showGitErrorPopover } = await import('../../src/ui/git-activity-overlay.ts');
    showGitErrorPopover({ error: 'cancelled' });
    assert.equal(document.querySelector('.mn-toast'), null);
  });

  for (const throws of [false, true]) {
    it(`routes ${throws ? 'thrown' : 'returned'} failures to surface recovery without a duplicate notification`, async () => {
      setupDom();
      const { runGitUiOp } = await import('../../src/ui/git-ui-op.ts');
      const errors: string[] = [];
      const result = await runGitUiOp(async () => {
        if (throws) throw new Error('CONFLICT in file.ts');
        return { ok: false, error: 'CONFLICT in file.ts' };
      }, { onError: error => errors.push(error), delayMs: 0 });
      assert.equal(result.ok, false);
      assert.deepEqual(errors, ['CONFLICT in file.ts']);
      assert.equal(document.querySelector('.mn-toast--error'), null);
      assert.equal(document.querySelector('.mn-git-activity--visible'), null);
    });
  }
});
