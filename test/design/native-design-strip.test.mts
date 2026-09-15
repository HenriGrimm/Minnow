import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mountNativeDesignStrip } from '../../src/design/native-design-strip.ts';
import { createIcon, type IconName } from '../../src/ui/icon.ts';

test('native toolbar floats, forwards actions, survives navigation and cleans up', async () => {
  const renderer = new Window();
  const guest = new Window({ settings: { enableJavaScriptEvaluation: true } });
  globalThis.window = renderer as unknown as Window & typeof globalThis;
  globalThis.document = renderer.document;
  (window as any).minnow = { preview: { execJs: async (code: string) => guest.eval(code) } };
  const strip = document.createElement('div');
  strip.style.setProperty('--mn-accent', 'rgb(220, 120, 35)');
  const icons: IconName[] = ['designMode', 'edit', 'appChat', 'deviceMobile', 'deviceTablet',
    'deviceDesktop', 'moon', 'close', 'undo', 'clear', 'expand', 'arrowUp', 'fileText'];
  for (const name of icons) {
    const button = document.createElement('button');
    button.title = name;
    button.setAttribute('aria-label', name);
    button.appendChild(createIcon(name));
    strip.appendChild(button);
  }
  document.body.appendChild(strip);
  let clicks = 0;
  strip.querySelector('button')!.addEventListener('click', () => clicks++);
  const stop = mountNativeDesignStrip('workspace-preview', strip);
  const wait = () => new Promise(resolve => setTimeout(resolve, 200));
  try {
    await wait();
    const host = guest.document.getElementById('mn-native-design-strip')!;
    assert.equal(host.style.position, 'fixed');
    assert.equal(host.style.bottom, '12px');
    const root = host.shadowRoot!;
    assert.equal(root.querySelectorAll('.fi').length, 0, 'guest must not depend on app icon fonts');
    assert.equal(root.querySelectorAll('svg').length, icons.length);
    for (const svg of root.querySelectorAll('svg')) {
      assert.equal(svg.getAttribute('viewBox'), '0 0 300 300');
      assert.equal(svg.querySelector('path')!.getAttribute('fill'), 'currentColor');
      assert.ok(svg.querySelector('path')!.getAttribute('d')!.length > 10);
    }
    // Clicking the artwork itself still forwards the containing button's action.
    root.querySelector('path')!.dispatchEvent(new guest.MouseEvent('click', { bubbles: true, composed: true }));
    await wait();
    assert.equal(clicks, 1);
    assert.equal(guest.document.getElementById(host.id), host, 'sync preserves the overlay host');
    host.remove();
    await wait();
    assert.ok(guest.document.getElementById(host.id), 'remounts after guest navigation');
  } finally {
    stop();
    await wait();
    assert.equal(guest.document.getElementById('mn-native-design-strip'), null);
    await guest.happyDOM.close();
    await renderer.happyDOM.close();
  }
});
