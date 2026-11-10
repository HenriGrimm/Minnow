import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';

test('the Graphite stage covers the sidebar as it grows', { timeout: 30_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);
  const styles = await Promise.all(['tokens', 'minnowos-tokens', 'minnowos-shell', 'minnowos-rail', 'graphite-workspace'].map(name =>
    readFile(new URL(`../../src/styles/${name}.css`, import.meta.url), 'utf8')));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-graphite-sidebar-'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html class="mn-graphite-workspace mn-graphite-sidebar-open">
      <style>${styles.join('\n').replace("@import './minnowos-tokens.css';", '')}
        body { margin: 0; }
      </style>
      <div class="mn-os">
        <header id="osMenubar" class="mn-os-menubar" data-view="app"></header>
        <div id="osWorkspace" class="mn-os-workspace">
          <nav id="osAppRail">Workspace navigation</nav>
          <main id="osStage" class="mn-os-stage is-in-app">Workspace content</main>
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
  await session.navigate(`http://127.0.0.1:${server.address().port}/`);
  await session.client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });

  const { start, during, end } = await session.evaluate(`(() => {
    const stage = document.getElementById('osStage');
    const rail = document.getElementById('osAppRail');
    const measure = () => {
      const { left, right, top } = stage.getBoundingClientRect();
      return { left, right, top, railRight: rail.getBoundingClientRect().right,
        coversRail: stage.contains(document.elementFromPoint(left + 16, 120)) };
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
    return { start, during, end: measure() };
  })()`);

  assert.equal(start.left, start.railRight);
  assert.equal(end.railRight, 0);
  assert.equal(end.left, 8);
  assert.equal(end.top, 52);
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
