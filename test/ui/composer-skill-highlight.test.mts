/**
 * Composer overlay paints known slash skills as chips over transparent text.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { initComposerSkillHighlight, syncComposerSkillHighlight } = await import(
  '../../src/ui/composer-skill-highlight.ts'
);

let domWindow: Window | null = null;

function setupComposer(): HTMLTextAreaElement {
  const window = new Window();
  domWindow = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  globalThis.HTMLDivElement = window.HTMLDivElement;
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  globalThis.window = window as unknown as Window & typeof globalThis;

  document.body.innerHTML = `<div class="input-wrap"><textarea id="msgInput"></textarea></div>`;
  return document.getElementById('msgInput') as HTMLTextAreaElement;
}

afterEach(() => {
  domWindow?.happyDOM.close();
  domWindow = null;
});

describe('composer skill highlight', () => {
  test('matches the text width when a native scrollbar is visible', () => {
    const input = setupComposer();
    input.style.border = '1px solid';
    Object.defineProperty(input, 'offsetWidth', { value: 400 });
    Object.defineProperty(input, 'clientWidth', { configurable: true, value: 383 });
    initComposerSkillHighlight(input);
    const layer = input.parentElement?.querySelector('.composer-skill-highlight') as HTMLDivElement;
    assert.equal(layer.style.right, '15px');
    Object.defineProperty(input, 'clientWidth', { value: 398 });
    syncComposerSkillHighlight(input);
    assert.equal(layer.style.right, '0px');
  });

  test('wraps the textarea and paints known skill tokens', () => {
    const input = setupComposer();
    initComposerSkillHighlight(input);
    input.value = '/impeccable polish the chips';
    syncComposerSkillHighlight(input);

    const host = input.parentElement;
    assert.equal(host?.className, 'composer-skill-highlight-host');
    const layer = host?.querySelector('.composer-skill-highlight');
    assert.ok(layer);
    assert.equal(layer?.querySelector('.skill-chip')?.textContent, '/impeccable');
    assert.match(layer?.textContent ?? '', /polish the chips/);
  });
});
