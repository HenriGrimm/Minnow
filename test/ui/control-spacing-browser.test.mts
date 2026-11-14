import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';
import type { BrowserSession } from '../../server/browser-driver/index.js';
import { modelProducerLogoSvg } from '../../src/providers/model-producer.ts';
import { iconHtml } from '../../src/ui/icon.ts';

// The driver's runtime exposes its CDP client; the public app-facing declaration
// intentionally covers only the high-level browser actions.
type TestSession = BrowserSession & {
  client: { send(method: string, params: Record<string, unknown>): Promise<unknown> };
};
type Bounds = Pick<DOMRect, 'left' | 'right' | 'width' | 'height' | 'y'>;
interface Measurement {
  coarse: boolean;
  bar: Bounds;
  expand: Bounds;
  send: Bounds;
  controls: { label: string; rect: Bounds; centered: boolean; clickable: boolean }[];
  marks: { logo: Bounds; centered: boolean; ringCentered: boolean }[];
}

test('sidebar marks and composer actions stay centered, separated and reachable', { timeout: 45_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-control-spacing-'));
  const styles = await Promise.all([
    'tokens', 'global', 'sidebar', 'input', 'mode-selector', 'view-mode-toggle',
    'composer-model-trigger', 'composer-expand', 'composer-overflow', 'mobile-app',
  ].map(name => readFile(new URL(`../../src/styles/${name}.css`, import.meta.url), 'utf8')));
  const icon = (name: Parameters<typeof iconHtml>[0]) => iconHtml(name);
  const mark = (model: string, agent = false) => `<div class="chat-item-row ${agent ? 'chat-item-row--agent' : ''}" data-agent-state="running">
    <span class="chat-item-logo">${modelProducerLogoSvg(model) || icon('appModels')}
      <span class="chat-item-dot" data-dot-state="working"><span class="chat-item-dot__spinner"></span></span>
    </span><span class="chat-item-name">${model}</span></div>`;
  const server = http.createServer(async (request, response) => {
    // Load the real icon font and its generated CSS, not a geometric placeholder.
    if (request.url?.startsWith('/icons/')) {
      const file = path.basename(request.url);
      const data = await readFile(new URL(`../../src/styles/vendor/uicons/${file}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : 'font/woff2' });
      response.end(data);
      return;
    }
    const icons = await readFile(new URL('../../src/styles/icons.css', import.meta.url), 'utf8');
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html data-theme="graphite-dark"><head>
      <style>${styles.join('\n')}${icons.replaceAll('./vendor/uicons/', '/icons/')}
        #sidebar { position: relative; width: 240px; height: auto; }
      </style></head><body>
      <aside id="sidebar" class="chat-sidebar mobile-open">${['gpt-5', 'claude-opus-4', 'gemini-3', 'unknown'].map(model => mark(model)).join('')}${mark('gpt-5', true)}</aside>
      <div class="input-bar">
        <div class="input-bar-composer">
          <div class="input-row"><div class="input-wrap input-wrap--inset-actions"><textarea class="composer-textarea" aria-label="Message"></textarea></div></div>
          <div class="composer-controls composer-controls--compact">
            <button class="input-inset-btn composer-attach-btn" aria-label="Attach">${icon('attach')}</button>
            <div class="composer-controls__trail"><div class="composer-model-trigger-anchor"><button class="composer-model-trigger" aria-label="Model"><span class="composer-model-trigger__label">A deliberately long model name and reasoning level</span></button></div></div>
            <button class="composer-overflow-btn" aria-label="Composer settings">${icon('settings')}</button>
          </div>
        </div>
        <div class="input-bar-send-stack"><div class="input-inset-actions">
          <button class="input-inset-btn mic" aria-label="Dictate">${icon('mic')}</button>
          <button class="input-inset-btn composer-expand-undo-btn" aria-label="Undo expansion" hidden>${icon('undo')}</button>
          <button class="input-inset-btn composer-expand-btn" aria-label="Expand prompt">${iconHtml('sparkles', { className: 'composer-expand-btn__icon' })}<span class="composer-expand-btn__spinner"></span></button>
        </div><button class="send-btn" aria-label="Send">${icon('composerSend')}</button></div>
      </div></body></html>`);
  });
  let session: TestSession | undefined;
  t.after(async () => {
    await session?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const result = await launchBrowser({ executablePath: browser.executablePath,
    profileDir: path.join(scratch, 'profile'), allowedOriginPatterns: ['http://127.0.0.1:*'],
    viewport: { width: 1440, height: 900 }, hardTimeoutMs: 40_000 });
  if (!result.ok) assert.fail(result.detail);
  session = result.session as TestSession;
  await session.navigate(`http://127.0.0.1:${address.port}/`);
  await session.evaluate('document.fonts.ready.then(() => true)');

  for (const coarse of [false, true]) {
    await session.client.send('Emulation.setTouchEmulationEnabled', { enabled: coarse, maxTouchPoints: 1 });
    await session.client.send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ] });
    for (const width of [1440, 760, 390, 320]) {
      await session.client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, mobile: false, deviceScaleFactor: 1 });
      for (const undoVisible of [false, true]) {
        const measurement = await session.evaluate(`(() => {
          document.body.classList.toggle('m-thread', ${coarse && width < 640});
          document.querySelector('.composer-expand-undo-btn').hidden = ${!undoVisible};
          const bar = document.querySelector('.input-bar');
          const rect = element => element.getBoundingClientRect().toJSON();
          const controls = [...bar.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width);
          return {
            coarse: matchMedia('(pointer: coarse)').matches,
            bar: rect(bar),
            expand: rect(bar.querySelector('.composer-expand-btn')),
            send: rect(bar.querySelector('.send-btn')),
            controls: controls.map(button => {
              const r = button.getBoundingClientRect(), i = button.querySelector('.icon-svg')?.getBoundingClientRect();
              return { label: button.getAttribute('aria-label'), rect: rect(button), centered: !i || Math.abs(i.x + i.width / 2 - r.x - r.width / 2) < 0.1 && Math.abs(i.y + i.height / 2 - r.y - r.height / 2) < 0.1,
                clickable: button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
            }),
            marks: [...document.querySelectorAll('.chat-item-logo')].map(host => {
              const r = host.getBoundingClientRect(), logo = host.firstElementChild.getBoundingClientRect();
              const ring = host.closest('.chat-item-row--agent') ? getComputedStyle(host, '::after') : null;
              const spinner = host.querySelector('.chat-item-dot__spinner').getBoundingClientRect();
              return { logo: logo.toJSON(), centered: Math.abs(logo.x + logo.width / 2 - r.x - r.width / 2) < 0.1 && Math.abs(logo.y + logo.height / 2 - r.y - r.height / 2) < 0.1,
                ringCentered: ring ? ring.left === ring.right && ring.top === ring.bottom : Math.abs(spinner.x + spinner.width / 2 - r.x - r.width / 2) < 0.1 && Math.abs(spinner.y + spinner.height / 2 - r.y - r.height / 2) < 0.1 };
            }),
          };
        })()`) as Measurement;
        assert.equal(measurement.coarse, coarse);
        assert.equal(measurement.send.left - measurement.expand.right, 8, 'Send has a separate 8px gutter');
        assert.equal(measurement.send.y + measurement.send.height / 2, measurement.expand.y + measurement.expand.height / 2);
        for (const control of measurement.controls) {
          assert.ok(control.centered, 'icon is centered in its button');
          assert.ok(control.clickable, 'button center is not covered');
          assert.ok(control.rect.left >= measurement.bar.left && control.rect.right <= measurement.bar.right, 'control fits the card');
          if (coarse) assert.ok(control.rect.width >= 44 && control.rect.height >= 44, `${control.label} touch target at ${width}px: ${control.rect.width} × ${control.rect.height}`);
        }
        for (const mark of measurement.marks) {
          assert.ok(mark.centered && mark.ringCentered, 'logo and ring share a center');
          assert.equal(mark.logo.width % 2, 0, 'even-sized logos avoid half-pixel placement');
          assert.ok(Number.isInteger(mark.logo.left), 'logo starts on a full pixel');
        }
      }
    }
  }
  await session.evaluate("document.querySelector('.composer-expand-undo-btn').focus()");
  await session.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await session.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const busy = await session.evaluate(`(() => {
    const button = document.querySelector('.composer-expand-btn');
    button.classList.add('composer-expand-btn--busy');
    const ring = button.querySelector('.composer-expand-btn__spinner');
    const r = button.getBoundingClientRect(), s = ring.getBoundingClientRect();
    return { animation: getComputedStyle(ring).animationName, outline: getComputedStyle(button).outlineStyle, focused: document.activeElement === button,
      centered: s.x + s.width / 2 === r.x + r.width / 2 && s.y + s.height / 2 === r.y + r.height / 2 };
  })()`) as { animation: string; outline: string; focused: boolean; centered: boolean };
  assert.equal(busy.animation, 'none', 'reduced motion keeps busy feedback static');
  assert.ok(busy.focused, 'Tab reaches Expand after Undo');
  assert.equal(busy.outline, 'solid', 'keyboard focus stays visible');
  assert.ok(busy.centered, 'expansion spinner stays centered too');
});
