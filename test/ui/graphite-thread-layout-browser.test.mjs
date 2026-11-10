import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';

test('Graphite keeps the composer, transcript and metrics aligned as the stage resizes', { timeout: 30_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-graphite-layout-'));
  const styles = await Promise.all(['tokens', 'code-chrome', 'input', 'chat-thread', 'thread-card', 'stats'].map(name =>
    readFile(new URL(`../../src/styles/${name}.css`, import.meta.url), 'utf8')));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><style>${styles.join('\n')}
      * { box-sizing: border-box; } body { margin: 0; }
      #mainColumn { display: flex; flex-direction: column; width: calc(100vw - 300px); margin-left: 292px; }
      #workspaceSplit[data-side-open] > #mainColumn { width: calc(100vw - 740px); }
      #chatArea { display: flex; flex-direction: column; }
    </style><main id="workspaceSplit">
      <header id="graphiteThreadHeader"></header>
      <section id="mainColumn" class="main-column">
        <div id="chatArea" class="chat-thread"><div class="msg assistant">A saved reply</div></div>
        <div class="input-bar">Message</div><button class="graphite-metrics-trigger">Metrics</button>
      </section>
    </main>`);
  });
  let session;
  t.after(async () => {
    await session?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = await launchBrowser({ executablePath: browser.executablePath,
    profileDir: path.join(scratch, 'profile'), allowedOriginPatterns: ['http://127.0.0.1:*'],
    viewport: { width: 1440, height: 900 }, hardTimeoutMs: 25_000 });
  assert.ok(result.ok, result.detail);
  session = result.session;
  await session.navigate(`http://127.0.0.1:${server.address().port}/`);

  for (const [viewport, sideOpen, expected] of [[1440, false, 660], [1728, false, 821], [1440, true, 628]]) {
    await session.client.send('Emulation.setDeviceMetricsOverride', { width: viewport, height: 900, mobile: false, deviceScaleFactor: 1 });
    const { composer, transcript, metrics } = await session.evaluate(`(() => {
      document.getElementById('workspaceSplit').toggleAttribute('data-side-open', ${sideOpen});
      const measure = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { composer: measure('.input-bar'), transcript: measure('.msg'), metrics: measure('.graphite-metrics-trigger') };
    })()`);
    assert.ok(Math.abs(composer.width - expected) < 1, JSON.stringify(composer));
    assert.equal(composer.width, transcript.width);
    assert.equal(composer.left, transcript.left);
    assert.ok(metrics.left >= composer.left && metrics.right <= composer.right);
  }
});
