import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';

test('Graphite issue details stay full height while the bulk toolbar is visible', { timeout: 30_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);
  const styles = await Promise.all(['tokens', 'issues', 'graphite-apps'].map(name =>
    readFile(new URL(`../../src/styles/${name}.css`, import.meta.url), 'utf8')));
  const rows = Array.from({ length: 36 }, (_, index) => `<div class="issues-row">Issue ${index + 1}</div>`).join('');
  const actions = ['Status', 'Priority', 'Assignee', 'Labels', 'Project', 'Delete', 'Clear']
    .map(action => `<button class="issues-btn">${action}</button>`).join('');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html class="mn-graphite-apps"><style>${styles.join('\n')}
      * { box-sizing: border-box; } body { height: 100vh; margin: 0; }
    </style>
    <main class="issues-page is-open">
      <div class="issues-shell is-detail is-detail-inline">
        <div class="issues-body">
          <div class="issues-selection-bar" hidden>
            <span class="issues-selection-bar__count">2 issues selected</span>
            <div class="issues-selection-bar__actions">${actions}</div>
          </div>
          <div class="issues-list-pane"><div class="issues-main">${rows}</div></div>
          <button class="issues-detail-scrim" hidden></button>
          <div class="issues-detail-host is-open">
            <div class="issues-detail">
              <div class="issues-detail__sticky">Issue details</div>
              <div class="issues-detail__scroll">${rows}</div>
              <div class="issues-detail__workflow">Work on this</div>
            </div>
          </div>
        </div>
      </div>
    </main>`);
  });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-issues-layout-'));
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
    allowedOriginPatterns: ['http://127.0.0.1:*'], viewport: { width: 1440, height: 900 },
    hardTimeoutMs: 25_000,
  });
  assert.ok(result.ok, result.detail);
  session = result.session;
  await session.navigate(`http://127.0.0.1:${server.address().port}/`);

  const measure = visible => session.evaluate(`(() => {
    const bar = document.querySelector('.issues-selection-bar');
    bar.hidden = ${!visible};
    const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    const list = document.querySelector('.issues-list-pane');
    const detailScroll = document.querySelector('.issues-detail__scroll');
    return {
      body: bounds('.issues-body'), bar: bounds('.issues-selection-bar'),
      list: bounds('.issues-list-pane'), detail: bounds('.issues-detail-host'),
      workflow: bounds('.issues-detail__workflow'),
      listOverflows: list.scrollHeight > list.clientHeight,
      detailOverflows: detailScroll.scrollHeight > detailScroll.clientHeight,
    };
  })()`);

  const initial = await measure(false);
  assert.equal(initial.list.top, initial.body.top);
  assert.equal(initial.detail.bottom, initial.body.bottom);
  let wideBarHeight;
  for (const width of [1440, 800]) {
    await session.client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, mobile: false, deviceScaleFactor: 1 });
    const { body, bar, list, detail, workflow, listOverflows, detailOverflows } = await measure(true);
    assert.ok(bar.height > 0 && bar.height < 120, `Toolbar height at ${width}px: ${bar.height} (body: ${body.height}px)`);
    assert.equal(bar.top, body.top);
    assert.equal(bar.bottom, list.top, JSON.stringify({ body, bar, list, detail }));
    assert.equal(list.bottom, body.bottom);
    assert.equal(bar.right, detail.left);
    assert.equal(list.right, detail.left);
    assert.equal(detail.top, body.top);
    assert.equal(detail.bottom, body.bottom);
    assert.equal(workflow.bottom, detail.bottom);
    assert.ok(listOverflows);
    assert.ok(detailOverflows);
    if (width === 1440) wideBarHeight = bar.height;
    else assert.ok(bar.height > wideBarHeight, 'The toolbar wraps when the list column is narrow');
  }
  const cleared = await measure(false);
  assert.equal(cleared.list.top, cleared.body.top);
  assert.equal(cleared.detail.bottom, cleared.body.bottom);
});
