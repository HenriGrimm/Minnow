import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));

test('completed replies remain reachable by native scrolling after history paging and reversal', { timeout: 90_000 }, async t => {
  const capability = await discoverBrowser();
  if (!capability.available) return t.skip(capability.detail);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-scroll-browser-'));
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = scratch;
  resetMinnowHomeCache();
  let session;
  let server;
  t.after(async () => {
    try {
      await session?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    } finally {
      if (previousHome === undefined) delete process.env.MINNOW_HOME;
      else process.env.MINNOW_HOME = previousHome;
      resetMinnowHomeCache();
      assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
      await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  const bundle = await build({
    entryPoints: [path.join(repo, 'test/fixtures/ui/transcript-scroll-browser.ts')],
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120',
  });
  const css = (await Promise.all(['tokens.css', 'chat-thread.css', 'messages.css'].map(name =>
    fs.readFile(path.join(repo, 'src/styles', name), 'utf8'),
  ))).join('\n').replace(/@import[^;]+;/g, '');
  server = http.createServer((req, res) => {
    if (req.url === '/fixture.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><style>${css}
        *{box-sizing:border-box}html,body{margin:0;height:100%;font:14px system-ui}
        #shell{height:100%;display:flex;flex-direction:column;overflow:hidden}
        #composer{height:140px;flex-shrink:0}#chatJumpLatest{position:absolute;bottom:150px}
      </style><div id="shell"><main id="chatArea" class="chat-area chat-thread" data-chat-view="compact"></main>
        <button id="chatJumpLatest" hidden>Jump to latest</button><div id="composer">Composer</div>
      </div><script src="/fixture.js"></script>`);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const launched = await launchBrowser({ executablePath: capability.executablePath,
    profileDir: path.join(scratch, 'profile'), allowedOriginPatterns: ['http://127.0.0.1:*'],
    viewport: { width: 1440, height: 1000 }, extraArgs: ['--enable-smooth-scrolling'], hardTimeoutMs: 80_000,
  });
  assert.ok(launched.ok, launched.detail);
  session = launched.session;
  await session.navigate(`http://127.0.0.1:${server.address().port}/`);
  const settle = () => session.evaluate(`new Promise(resolve => {
    let count=0; const step=()=>++count===18?resolve(testScroll.snapshot()):requestAnimationFrame(step);
    requestAnimationFrame(step);
  })`, { awaitPromise: true });
  const wheel = deltaY => session.client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY,
  });
  await settle();
  for (const scale of [1, 0.8, 1.25]) {
    await session.evaluate(`document.documentElement.style.zoom=${scale}; testScroll.scroller.toBottom()`);
    await settle();
    const before = await session.evaluate('testScroll.snapshot()');
    for (let n = 0; n < 8; n++) await wheel(-600);
    // Reverse before waiting for pending history pages to settle.
    for (let n = 0; n < 24; n++) await wheel(900);
    const after = await settle();
    assert.ok(after.start <= before.start);
    assert.ok(after.distance <= 1, `native scrolling must reach the real tail at scale ${scale}: ${JSON.stringify(after)}`);
    assert.equal(after.pinned, true);
    assert.equal(after.chip, false);
    assert.ok(after.replyBottom <= after.viewportBottom + 1, 'the final paragraph must be visible above the composer');
    const top = after.top;
    await session.evaluate('testScroll.scroller.toBottom()');
    const jumped = await settle();
    assert.ok(Math.abs(jumped.top - top) <= 1, 'Jump to latest must have no hidden scroll distance left to recover');
  }
});
