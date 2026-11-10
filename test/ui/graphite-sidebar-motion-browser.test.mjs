import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';

test('the Graphite stage covers the sidebar as it grows and Windows controls stay at the right edge', { timeout: 30_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);
  const styles = await Promise.all(['tokens', 'minnowos-tokens', 'minnowos-shell', 'minnowos-rail', 'graphite-workspace', 'thread-card', 'graphite-apps'].map(name =>
    readFile(new URL(`../../src/styles/${name}.css`, import.meta.url), 'utf8')));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-graphite-sidebar-'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html class="is-electron-shell mn-graphite-workspace mn-graphite-sidebar-open mn-graphite-apps" data-platform="win32">
      <style>${styles.join('\n').replace("@import './minnowos-tokens.css';", '')}
        * { box-sizing: border-box; } body { margin: 0; }
      </style>
      <div class="mn-os">
        <header id="osMenubar" class="mn-os-menubar mn-os-menubar--shell-frameless" data-view="app">
          <div class="mn-os-mb-left"><button>Sidebar</button></div>
          <div class="mn-os-mb-right"><button id="settings">Settings</button></div>
          <div class="mn-os-mb-window-controls">
            <button class="mn-os-window-btn">−</button><button class="mn-os-window-btn">□</button><button class="mn-os-window-btn" id="close">×</button>
          </div>
        </header>
        <div id="osWorkspace" class="mn-os-workspace">
          <nav id="osAppRail">Workspace navigation</nav>
          <main id="osStage" class="mn-os-stage is-in-app">
            <div class="mn-os-app-layer is-active">
              <header id="graphiteThreadHeader"><h1 class="graphite-thread-title">Workspace content</h1>
                <div class="graphite-thread-header__actions"><button id="threadAction">Thread action</button></div>
              </header>
            </div>
          </main>
        </div>
      </div>
    </html>`);
  });
  let session;
  t.after(async () => {
    await session?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = await launchBrowser({
    executablePath: browser.executablePath, profileDir: path.join(scratch, 'profile'),
    allowedOriginPatterns: ['http://127.0.0.1:*'],
    viewport: { width: 1440, height: 900 }, hardTimeoutMs: 25_000,
  });
  assert.ok(result.ok, result.detail);
  session = result.session;
  await session.client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, mobile: false, deviceScaleFactor: 1,
  });
  await session.navigate(`http://127.0.0.1:${server.address().port}/`);
  await session.client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });

  const { start, during, end, withoutThread } = await session.evaluate(`(() => {
    const stage = document.getElementById('osStage');
    const rail = document.getElementById('osAppRail');
    const bounds = selector => document.querySelector(selector).getBoundingClientRect();
    const measure = () => {
      const { left, right, top } = stage.getBoundingClientRect();
      const controls = bounds('.mn-os-mb-window-controls');
      const divider = getComputedStyle(document.querySelector('.mn-os-mb-window-controls'), '::before');
      const close = bounds('#close');
      return { left, right, top, railRight: rail.getBoundingClientRect().right,
        coversRail: stage.contains(document.elementFromPoint(left + 16, 120)),
        controls: controls.toJSON(),
        dividerWidth: divider.width,
        minimizeLeft: bounds('.mn-os-mb-window-controls button').left,
        closeClickable: document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2)?.id === 'close',
        threadActionRight: bounds('#threadAction').right, settingsRight: bounds('#settings').right };
    };
    const start = measure();
    document.documentElement.classList.add('mn-graphite-sidebar-motion');
    document.documentElement.classList.remove('mn-graphite-sidebar-open');
    const transitions = stage.getAnimations();
    const during = [0.1, 0.25, 0.5].map(fraction => {
      for (const transition of transitions) {
        transition.pause();
        transition.currentTime = transition.effect.getTiming().duration * fraction;
      }
      return measure();
    });
    for (const transition of transitions) transition.finish();
    document.documentElement.classList.remove('mn-graphite-sidebar-motion');
    const end = measure();
    document.getElementById('graphiteThreadHeader').hidden = true;
    document.documentElement.classList.add('mn-graphite-sidebar-open');
    return { start, during, end, withoutThread: measure() };
  })()`);

  assert.equal(start.left, start.railRight);
  assert.equal(end.railRight, 0);
  assert.equal(end.left, 8);
  assert.equal(end.top, 52);
  assert.equal(end.controls.right, 1440 - 22);
  assert.ok(end.settingsRight < end.controls.left);
  assert.ok(start.threadActionRight < start.controls.left);
  assert.ok(withoutThread.top >= withoutThread.controls.bottom);
  for (const frame of [start, ...during, end, withoutThread]) {
    assert.deepEqual(frame.controls, end.controls);
    assert.equal(frame.dividerWidth, '1px');
    assert.ok(frame.minimizeLeft > frame.controls.left + 1);
    assert.ok(frame.closeClickable);
  }
  let previous = start;
  for (const frame of during) {
    assert.ok(frame.left < previous.left && frame.left > end.left, JSON.stringify(frame));
    assert.ok(frame.top > previous.top && frame.top < end.top, JSON.stringify(frame));
    assert.equal(frame.right, start.right);
    assert.equal(frame.railRight, start.railRight);
    assert.ok(frame.coversRail);
    previous = frame;
  }
});
