import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { notify, showToast, resetToastsForTests } = await import('../../src/ui/toast.ts');
let dom;
beforeEach(() => {
  dom = new Window();
  globalThis.window = dom;
  globalThis.document = dom.document;
  globalThis.HTMLElement = dom.HTMLElement;
  globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
});
afterEach(() => {
  resetToastsForTests();
  dom.close();
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('toast', () => {
  test('ordinary feedback is politely announced and times out', async () => {
    showToast('Committed changes', 'success', 15);
    assert.equal(document.querySelector('.mn-toast__message').textContent, 'Committed changes');
    const live = document.querySelector('[role="status"]');
    assert.equal(live.getAttribute('aria-live'), 'polite');
    assert.equal(live.textContent, 'Committed changes');
    await wait(35);
    assert.equal(document.querySelector('.mn-toast'), null);
    assert.equal(document.querySelector('.mn-toast-stack'), null);
  });

  test('errors are assertive, stay longer by default and are independently dismissible', async () => {
    showToast('Git operation failed', 'error');
    showToast('Another error', 'error');
    await wait(20);
    assert.equal(document.querySelectorAll('.mn-toast').length, 2);
    assert.equal(document.querySelector('[role="alert"]').getAttribute('aria-live'), 'assertive');
    document.querySelector('.mn-toast__dismiss').click();
    assert.equal(document.querySelectorAll('.mn-toast').length, 1);
    assert.equal(document.querySelector('.mn-toast__message').textContent, 'Another error');
  });

  test('long content expands to the full literal text and collapses', () => {
    const message = '<script>not HTML</script> ' + 'long content '.repeat(30);
    showToast(message, 'error');
    const content = document.querySelector('.mn-toast__message');
    const expand = document.querySelector('.mn-toast__expand');
    assert.ok(content.textContent.length < message.length);
    assert.equal(expand.getAttribute('aria-expanded'), 'false');
    assert.equal(expand.getAttribute('aria-controls'), content.id);
    expand.click();
    assert.equal(content.textContent, message.trim());
    assert.equal(expand.getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelector('script'), null);
    expand.click();
    assert.ok(content.textContent.endsWith('…'));
  });

  test('identical messages collapse by variant, count and reset ordinary timeout', async () => {
    showToast('Finished', 'success', 60);
    await wait(35);
    showToast(' Finished ', 'success', 60);
    assert.equal(document.querySelectorAll('.mn-toast').length, 1);
    assert.equal(document.querySelector('.mn-toast__count').textContent, '×2');
    assert.match(document.querySelector('[role="status"]').textContent, /repeated 2 times/);
    await wait(35);
    assert.equal(document.querySelectorAll('.mn-toast').length, 1);
    showToast('Finished', 'error');
    assert.equal(document.querySelectorAll('.mn-toast').length, 2);
    await wait(50);
    assert.equal(document.querySelectorAll('.mn-toast').length, 1);
  });

  test('hover, keyboard focus and expansion pause timeouts', async () => {
    showToast('Read this carefully '.repeat(20), 'success', 15);
    const toast = document.querySelector('.mn-toast');
    toast.dispatchEvent(new dom.Event('mouseenter'));
    await wait(30);
    assert.ok(toast.isConnected);
    toast.dispatchEvent(new dom.Event('mouseleave'));
    const expand = toast.querySelector('.mn-toast__expand');
    expand.focus();
    await wait(30);
    assert.ok(toast.isConnected);
    expand.click();
    expand.blur();
    await wait(30);
    assert.ok(toast.isConnected);
    expand.click();
    await wait(30);
    assert.equal(toast.isConnected, false);
  });

  test('dismiss does not steal focus; keyboard dismissal returns focus', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    showToast('Failed', 'error');
    assert.equal(document.activeElement, trigger);
    const close = document.querySelector('.mn-toast__dismiss');
    close.focus();
    close.click();
    assert.equal(document.activeElement, trigger);
  });

  test('blank messages are ignored and detached toasts do not absorb later messages', () => {
    showToast('  ');
    assert.equal(document.querySelector('.mn-toast'), null);
    showToast('Repeated', 'error');
    document.body.replaceChildren();
    showToast('Repeated', 'error');
    assert.equal(document.querySelectorAll('.mn-toast').length, 1);
    assert.equal(document.querySelector('.mn-toast__count').hidden, true);
  });
  test('rich cards show source, open their target and run actions', async () => {
    let opened = 0;
    let sent = 0;
    notify({
      tone: 'error',
      source: 'Source Control',
      context: 'push · main',
      title: 'Push rejected',
      message: 'Pull, then push again.',
      detail: '! [rejected] main -> main',
      open: () => { opened += 1; },
      actions: [{ label: 'Send to chat', variant: 'primary', run: () => { sent += 1; } }],
    });
    const card = document.querySelector('.mn-toast');
    assert.equal(card.querySelector('.mn-toast__source').textContent, 'Source Control');
    assert.equal(card.querySelector('.mn-toast__context').textContent, 'push · main');
    assert.equal(card.querySelector('.mn-toast__title').textContent, 'Push rejected');
    const detail = card.querySelector('.mn-toast__detail');
    assert.equal(detail.hidden, true);
    card.querySelector('.mn-toast__expand').click();
    assert.equal(detail.hidden, false);
    card.querySelector('.mn-toast__action--primary').click();
    await wait(0);
    assert.equal(sent, 1);
    assert.equal(card.isConnected, false);
    notify({ title: 'Agent finished', source: 'Code', open: () => { opened += 1; } });
    document.querySelector('.mn-toast__open').click();
    assert.equal(opened, 1);
    assert.equal(document.querySelector('.mn-toast'), null);
  });

  test('actions can swap in a confirmation or keep the card with an error', async () => {
    notify({
      title: 'Saved memory',
      source: 'Brain',
      actions: [
        { label: 'Fail', run: () => { throw new Error('Nope'); } },
        { label: 'Reject', run: () => ({ message: 'Memory rejected' }) },
      ],
    });
    const [fail, reject] = document.querySelectorAll('.mn-toast__action');
    fail.click();
    await wait(0);
    assert.equal(document.querySelector('.mn-toast__error').textContent, 'Nope');
    assert.equal(fail.disabled, false);
    reject.click();
    await wait(0);
    const cards = document.querySelectorAll('.mn-toast');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].querySelector('.mn-toast__message').textContent, 'Memory rejected');
    assert.ok(cards[0].classList.contains('mn-toast--compact'));
  });

  test('cards that wait on the user have no timer and show a tag', async () => {
    notify({ tone: 'attention', source: 'Code', title: 'The agent has a question', durationMs: undefined });
    await wait(20);
    const card = document.querySelector('.mn-toast');
    assert.ok(card.isConnected);
    assert.equal(card.querySelector('.mn-toast__timer'), null);
    assert.equal(card.querySelector('.mn-toast__tag').textContent, 'Needs you');
    assert.equal(card.querySelector('[role="alert"]').getAttribute('aria-live'), 'assertive');
  });

  test('only the three newest cards show; older ones fold behind a pill', () => {
    for (let i = 1; i <= 5; i += 1) showToast(`Error ${i}`, 'error');
    const cards = [...document.querySelectorAll('.mn-toast')];
    assert.deepEqual(cards.map((card) => card.hidden), [true, true, false, false, false]);
    const more = document.querySelector('.mn-toast-more');
    assert.equal(more.textContent, '+2 more');
    more.click();
    assert.equal(document.querySelectorAll('.mn-toast[hidden]').length, 0);
    assert.equal(document.querySelector('.mn-toast-more'), null);
  });

  test('cards that wait on the user are folded last', () => {
    notify({ tone: 'attention', source: 'Code', title: 'Question' });
    for (let i = 1; i <= 3; i += 1) showToast(`Error ${i}`, 'error');
    const cards = [...document.querySelectorAll('.mn-toast')];
    assert.deepEqual(cards.map((card) => card.hidden), [false, true, false, false]);
  });

  test('Escape on a focused card dismisses it', () => {
    showToast('Failed', 'error');
    const card = document.querySelector('.mn-toast');
    card.querySelector('.mn-toast__dismiss').focus();
    card.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.querySelector('.mn-toast'), null);
  });
});
