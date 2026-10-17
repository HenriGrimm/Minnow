import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { setStatus, setReadyStatus, clearStaleGenerationStatus } = await import('../../src/ui/status.ts');
let dom;
beforeEach(() => {
  dom = new Window();
  globalThis.window = dom;
  globalThis.document = dom.document;
  globalThis.HTMLElement = dom.HTMLElement;
  globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
});
afterEach(() => dom.close());

describe('header-free status routing', () => {
  test('idle, routine success, readiness and progress are silent', () => {
    for (const [state, message] of [['idle', ''], ['ok', 'Ready'], ['ok', 'Saved'], ['spin', 'Generating reply…']]) {
      setStatus(state, message);
    }
    setReadyStatus();
    clearStaleGenerationStatus(false);
    assert.equal(document.querySelector('.mn-toast'), null);
  });
  test('both legacy error spellings produce persistent deduplicated error toasts', () => {
    setStatus('err', 'Could not save');
    setStatus('error', 'Could not save');
    setReadyStatus();
    assert.equal(document.querySelectorAll('.mn-toast--error').length, 1);
    assert.equal(document.querySelector('.mn-toast__message').textContent, 'Could not save');
    assert.equal(document.querySelector('[role="alert"]').getAttribute('aria-live'), 'assertive');
    assert.equal(document.querySelector('.mn-toast__count').textContent, '×2');
    document.querySelector('.mn-toast__dismiss').click();
    assert.equal(document.querySelector('.mn-toast'), null);
  });
  test('neither header constructs a status text or dot', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const menubar = readFileSync(new URL('../../src/os/menubar.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /id="(?:sDot|sText)"/);
    assert.doesNotMatch(menubar, /osStatusDot|osStatusText|statusPill|statusSep/);
  });
});
