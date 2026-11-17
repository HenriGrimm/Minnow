import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';

test('multiline question options start beside their numbers', { timeout: 30_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-question-layout-'));
  const css = await readFile(new URL('../../src/styles/question-cards.css', import.meta.url), 'utf8');
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><style>${css}</style><div id="options" class="question-cards-options">
      <label class="question-cards-option"><input type="checkbox"><kbd class="question-cards-key">1</kbd><span class="question-cards-option-content"><span class="question-cards-option-label">${'A long answer that needs multiple lines. '.repeat(8)}</span><span class="question-cards-option-desc">Optional description</span></span></label>
      <label class="question-cards-option"><input type="radio"><kbd class="question-cards-key">2</kbd><span class="question-cards-option-content"><span class="question-cards-option-label">${'unbroken'.repeat(60)}</span></span></label>
    </div>`);
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
    viewport: { width: 1000, height: 800 }, hardTimeoutMs: 25_000 });
  assert.ok(result.ok, result.detail);
  session = result.session;
  await session.navigate(`http://127.0.0.1:${server.address().port}/`);
  for (const width of [240, 400, 800]) {
    const measurements = await session.evaluate(`(() => {
      document.getElementById('options').style.width = '${width}px';
      return [...document.querySelectorAll('.question-cards-option')].map(row => {
        const key = row.querySelector('kbd').getBoundingClientRect();
        const label = row.querySelector('.question-cards-option-label');
        const range = document.createRange();
        range.setStart(label.firstChild, 0); range.setEnd(label.firstChild, 1);
        const first = range.getBoundingClientRect();
        return { keyTop: key.top, keyBottom: key.bottom, keyRight: key.right,
          firstTop: first.top, firstLeft: first.left, height: label.getBoundingClientRect().height,
          overflow: row.scrollWidth > row.clientWidth };
      });
    })()`);
    for (const row of measurements) {
      assert.ok(row.firstTop >= row.keyTop - 4 && row.firstTop < row.keyBottom, JSON.stringify(row));
      assert.ok(row.firstLeft >= row.keyRight, JSON.stringify(row));
      assert.ok(row.height > 20, 'fixture must wrap');
      assert.equal(row.overflow, false);
    }
  }
});
