import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { showToast } = await import('../../src/ui/toast.ts');
let dom;
beforeEach(() => {
  dom = new Window();
  globalThis.window = dom;
  globalThis.document = dom.document;
  globalThis.HTMLElement = dom.HTMLElement;
  globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
});
afterEach(() => dom.close());
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

  test('errors are assertive, persistent and independently dismissible', async () => {
    showToast('Git operation failed', 'error', 1);
    showToast('Another error', 'error', 1);
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
});
