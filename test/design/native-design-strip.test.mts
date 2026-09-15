import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mountNativeDesignStrip } from '../../src/design/native-design-strip.ts';

test('native toolbar floats, forwards actions, survives navigation and cleans up', async () => {
  const renderer = new Window();
  const guest = new Window({ settings: { enableJavaScriptEvaluation: true } });
  globalThis.window = renderer as unknown as Window & typeof globalThis;
  globalThis.document = renderer.document;
  (window as any).minnow = { preview: { execJs: async (code: string) => guest.eval(code) } };
  const strip = document.createElement('div');
  strip.style.setProperty('--mn-accent', 'rgb(220, 120, 35)');
  strip.innerHTML = '<button title="Draw">Draw</button>';
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
    host.shadowRoot!.querySelector('button')!.click();
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
