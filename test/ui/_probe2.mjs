import { Window } from 'happy-dom';

const window = new Window({ innerHeight: 800 });
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;

const { autoResize, setComposerFieldSizingSupportedForTests } =
  await import('../../src/ui/composer-auto-resize.ts');

function setupTextarea() {
  const el = document.createElement('textarea');
  el.id = 'msgInput';
  el.style.boxSizing = 'border-box';
  el.style.padding = '11px 14px';
  el.style.lineHeight = '1.55';
  el.style.fontSize = '14px';
  el.style.width = '400px';
  document.body.appendChild(el);
  return el;
}

// Confirm defineProperty shadows the prototype getters
const el = setupTextarea();
Object.defineProperty(el, 'offsetHeight', { value: 320, configurable: true });
Object.defineProperty(el, 'clientHeight', { value: 296, configurable: true });
Object.defineProperty(el, 'scrollHeight', { value: 310, configurable: true });
console.log('stubbed: offsetHeight', el.offsetHeight, 'clientHeight', el.clientHeight, 'scrollHeight', el.scrollHeight);

setComposerFieldSizingSupportedForTests(false);
el.style.minHeight = '300px';
el.value = 'lots of lines\n'.repeat(20);
autoResize(el);
console.log('after autoResize: overflowY', el.style.overflowY, 'height', el.style.height);
console.log('EXPECT overflowY=auto height<=320');

// Now shrink to one line
Object.defineProperty(el, 'scrollHeight', { value: 20, configurable: true });
Object.defineProperty(el, 'clientHeight', { value: 296, configurable: true });
el.value = 'one line';
autoResize(el);
console.log('after shrink: overflowY', el.style.overflowY, 'height', el.style.height);
console.log('EXPECT overflowY=hidden');
