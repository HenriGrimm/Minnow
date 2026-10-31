/**
 * Side-effect module: put a happy-dom `window` on globalThis before anything else.
 *
 * `dompurify` builds its sanitizer against `globalThis.window` at module eval, so a
 * suite that installs the DOM inside a test gets a DOMPurify with no `sanitize` —
 * every markdown render then throws. ESM evaluates imports in source order, so
 * importing this first makes the window exist by the time the renderer loads.
 */

import { Window } from 'happy-dom';
import { after } from 'node:test';

const window = new Window();
let closed = false;
for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame'] as const) {
  const schedule = window[name];
  Object.defineProperty(window, name, { configurable: true, value: (...args: unknown[]) =>
    closed ? 0 : Reflect.apply(schedule, window, args) });
}
after(async () => {
  // A deferred module cannot restart timers in a browser context that was closed.
  // Do not import unrelated app modules here: individual tests may mock them.
  window.dispatchEvent(new window.Event('pagehide'));
  closed = true;
  await window.happyDOM.close();
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = window;
g.document = window.document;
g.HTMLElement = window.HTMLElement;
g.Node = window.Node;
g.Element = window.Element;
g.DocumentFragment = window.DocumentFragment;
