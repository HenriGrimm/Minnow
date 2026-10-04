import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const source = html.match(/<script id="minnowBootGuard">([\s\S]*?)<\/script>/)![1];
const windows: Window[] = [];

function setup() {
  const win = new Window({ url: 'http://192.168.1.10:9473/#pair=123456' });
  windows.push(win);
  win.document.body.innerHTML = '<div id="app-loader" class="app-loader"><p id="appLoaderStatus">Loading…</p></div>';
  let timeout!: () => void;
  win.setTimeout = ((callback: () => void) => { timeout = callback; return 1; }) as typeof win.setTimeout;
  vm.runInNewContext(source, { window: win, document: win.document });
  return { win, timeout: () => timeout() };
}

afterEach(() => { for (const win of windows.splice(0)) win.close(); });

test('a failed module import shows recovery without loading the application bundle', () => {
  const { win } = setup();
  const script = win.document.createElement('script');
  script.type = 'module';
  win.document.body.appendChild(script);
  script.dispatchEvent(new win.Event('error'));
  assert.match(win.document.getElementById('appLoaderStatus')!.textContent!, /could not start/);
  assert.equal(win.document.getElementById('app-loader')!.getAttribute('role'), 'alert');
  assert.ok(win.document.getElementById('appLoaderRetry'));
  assert.equal(win.location.hash, '#pair=123456');
});

test('the fallback deadline retains the loader and offers retry instead of revealing blank chrome', () => {
  const { win, timeout } = setup();
  timeout();
  assert.equal(win.document.documentElement.classList.contains('app-ready'), false);
  assert.match(win.document.getElementById('appLoaderStatus')!.textContent!, /taking longer/);
  assert.ok(win.document.getElementById('appLoaderRetry'));
  win.document.documentElement.classList.add('app-ready');
  win.document.getElementById('app-loader')!.remove();
  timeout();
  assert.equal(win.document.getElementById('app-loader'), null, 'late deadline cannot cover a healthy app');
});

test('a rejected startup restores recovery even if coherent chrome had already removed the loader', () => {
  const { win } = setup();
  win.document.documentElement.classList.add('app-ready');
  win.document.getElementById('app-loader')!.remove();
  win.dispatchEvent(new win.Event('minnow-boot-failed'));
  assert.equal(win.document.documentElement.classList.contains('app-boot-failed'), true);
  assert.equal(win.document.getElementById('app-loader')!.getAttribute('aria-hidden'), 'false');
  assert.match(win.document.getElementById('appLoaderStatus')!.textContent!, /could not start/);
});

test('a stalled paired connection gets recovery controls on its visible connection screen', () => {
  const { win } = setup();
  const connecting = win.document.createElement('main');
  connecting.id = 'companionConnecting';
  win.document.body.appendChild(connecting);
  win.dispatchEvent(new win.Event('minnow-boot-stalled'));
  assert.equal(connecting.querySelector('button')!.textContent, 'Retry connection');
  assert.equal(win.document.documentElement.classList.contains('app-ready'), false);
  win.dispatchEvent(new win.Event('minnow-boot-failed'));
  assert.equal(connecting.querySelector('button'), null);
  assert.equal(win.document.querySelector('#app-loader button')!.textContent, 'Reload Minnow');
});

test('optional image errors do not fail startup and runtime errors after readiness do not replace the app', () => {
  const { win } = setup();
  const image = win.document.createElement('img');
  win.document.body.appendChild(image);
  image.dispatchEvent(new win.Event('error'));
  assert.equal(win.document.getElementById('appLoaderRetry'), null);
  win.document.documentElement.classList.add('app-ready');
  win.dispatchEvent(new win.ErrorEvent('error', { message: 'Unrelated later failure' }));
  assert.equal(win.document.documentElement.classList.contains('app-boot-failed'), false);
});
