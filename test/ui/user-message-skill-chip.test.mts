/**
 * User bubbles restore `/skill-id` chips instead of dropping the audit footer.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { renderUserMessageBubble } = await import('../../src/ui/user-message-bubble.ts');

let domWindow: Window | null = null;

function setupDom(): HTMLDivElement {
  const window = new Window();
  domWindow = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLDivElement = window.HTMLDivElement;
  globalThis.window = window as unknown as Window & typeof globalThis;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  document.body.appendChild(bubble);
  return bubble;
}

afterEach(() => {
  domWindow?.happyDOM.close();
  domWindow = null;
});

describe('user message skill chips', () => {
  test('renders a chip for a skill-only send', () => {
    const bubble = setupDom();
    renderUserMessageBubble(bubble, '[skill: impeccable]');
    const chip = bubble.querySelector('.skill-chip');
    assert.ok(chip);
    assert.equal(chip?.textContent, '/impeccable');
    assert.equal(bubble.textContent, '/impeccable');
  });

  test('renders chip plus remaining prompt text', () => {
    const bubble = setupDom();
    renderUserMessageBubble(bubble, 'lets improve the skill display\n\n[skill: impeccable]');
    const chip = bubble.querySelector('.skill-chip');
    assert.equal(chip?.textContent, '/impeccable');
    assert.match(bubble.textContent ?? '', /lets improve the skill display/);
  });
});
