import { Window } from 'happy-dom';

export function spatialTestDom() {
  const browser = new Window({ url: 'http://localhost/' });
  const keys = ['window', 'document', 'localStorage', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let disconnected = 0;
  const values = {
    window: browser, document: browser.document, localStorage: browser.localStorage,
    ResizeObserver: class { observe() {} disconnect() { disconnected++; } },
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    getComputedStyle: browser.getComputedStyle.bind(browser),
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  browser.HTMLCanvasElement.prototype.getContext = () => null;
  return {
    browser,
    disconnected: () => disconnected,
    destroy() {
      browser.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
