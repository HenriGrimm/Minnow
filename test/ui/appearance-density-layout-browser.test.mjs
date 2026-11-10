import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';

test('density changes workspace spacing and keeps chat rows steady on hover', { timeout: 30_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);
  const styles = await Promise.all([
    'tokens', 'sidebar', 'chat-thread', 'settings-page', 'settings-graphite', 'graphite-apps',
    'issues', 'models-page', 'models-graphite', 'file-panel', 'mobile-settings', 'dropdowns', 'brain-graph',
  ].map(name => readFile(new URL(`../../src/styles/${name}.css`, import.meta.url), 'utf8')));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-density-layout-'));
  const chatRow = git => `<div class="chat-item-row" tabindex="0"><div class="chat-item-head">
    <div class="chat-item-title-row"><span class="chat-item-logo"></span><span class="chat-item-name">A saved chat</span>
    <span class="chat-item-trailing"><span class="chat-item-git" ${git ? '' : 'hidden'}>+123 −45</span>
      <button class="chat-item-archive" aria-label="Archive chat">↗</button></span></div>
    </div></div>`;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html class="mn-graphite-apps" data-theme="graphite-dark"><style>${styles.join('\n')}
      * { box-sizing: border-box; } body { margin: 16px; font: 14px/1.5 system-ui; }
      #sidebar { width: 210px; } .chat-thread { display: flex; flex-direction: column; }
    </style><body>
    <div id="sidebar">${chatRow(false)}${chatRow(true)}${chatRow(false)}</div>
    <nav class="settings-nav"><details class="settings-nav-group" open>
      <summary class="settings-nav-group__label">General</summary>
      <button class="settings-nav__item" aria-current="page">Appearance</button>
      <button class="settings-nav__item">Notifications</button>
    </details></nav>
    <div id="settingsView" class="settings-page--graphite"><div class="settings-area">
      <div class="settings-group__body"><div class="settings-row">A setting</div></div></div></div>
    <div class="chat-thread"><div class="msg assistant"><div class="msg-bubble">A reply</div></div>
      <div class="msg assistant"><div class="msg-bubble">Another reply</div></div></div>
    <div class="file-tree-row">A file</div>
    <div class="issues-shell"><div class="issues-row">An issue</div></div>
    <div class="models-row">A model</div>
    <div class="brain-page is-graph-canvas-bg" style="display:block"><div class="brain-rail">
      <button class="brain-rail__btn">Graph</button></div></div>
    <button class="scc-rail__item">Changes</button>
    <div class="scheduler-graphite-job"><button class="scheduler-graphite-job__select">A job</button></div>
    <button class="m-phone-settings__row">Phone appearance</button>
    <button class="mn-dropdown__item">A menu action</button>
    </body></html>`);
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
    viewport: { width: 1280, height: 900 }, hardTimeoutMs: 25_000 });
  assert.ok(result.ok, result.detail);
  session = result.session;
  await session.navigate(`http://127.0.0.1:${server.address().port}/`);

  const rows = () => session.evaluate(`[...document.querySelectorAll('.chat-item-row')].map(row => ({
    ...row.getBoundingClientRect().toJSON(), title: row.querySelector('.chat-item-name').getBoundingClientRect().width,
  }))`);
  let previous;
  for (const density of ['compact', 'cozy', 'roomy']) {
    const metrics = await session.evaluate(`(() => {
      document.documentElement.dataset.density = '${density}';
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const height = selector => rect(selector).height;
      const navGap = rect('.settings-nav__item + button').top - rect('.settings-nav__item').bottom;
      return { navGap, dimensions: [height('.settings-nav__item'), height('.chat-item-row'), height('.settings-row'),
        height('.file-tree-row'), height('.issues-row'), height('.models-row'), height('.m-phone-settings__row'),
        height('.brain-rail__btn'), height('.scc-rail__item'), height('.scheduler-graphite-job'),
        height('.mn-dropdown__item'), parseFloat(getComputedStyle(document.querySelector('.chat-thread')).rowGap)] };
    })()`);
    assert.equal(metrics.navGap, 2);
    if (previous) {
      assert.ok(metrics.dimensions.every((value, index) => value > previous[index]),
        `${density}: ${metrics.dimensions} should exceed ${previous}`);
    }
    previous = metrics.dimensions;

    const resting = await rows();
    for (const row of resting.slice(0, 2)) {
      await session.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x + 25, y: row.y + row.height / 2 });
      assert.equal(await session.evaluate(`getComputedStyle(document.querySelector('.chat-item-row:hover .chat-item-archive')).visibility`), 'visible');
      assert.deepEqual(await rows(), resting);
    }
    await session.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 450, y: 20 });
    await session.evaluate(`document.querySelector('.chat-item-row').focus({ preventScroll: true })`);
    assert.equal(await session.evaluate(`getComputedStyle(document.querySelector('.chat-item-archive')).visibility`), 'visible');
    assert.deepEqual(await rows(), resting);
    await session.evaluate(`document.activeElement.blur()`);
  }

  await session.client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const touchHeights = await session.evaluate(`(() => {
    document.documentElement.dataset.density = 'compact';
    return ['.chat-item-row', '.settings-nav__item', '.file-tree-row', '.issues-row',
      '.models-row', '.m-phone-settings__row', '.mn-dropdown__item'].map(selector =>
      document.querySelector(selector).getBoundingClientRect().height);
  })()`);
  assert.ok(touchHeights.every(height => height >= 44), JSON.stringify(touchHeights));
});
