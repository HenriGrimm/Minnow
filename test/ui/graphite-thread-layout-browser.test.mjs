import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';

test('Graphite aligns the thread and keeps user bubbles snug with message actions', { timeout: 30_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-graphite-layout-'));
  const styles = await Promise.all([
    'tokens', 'code-chrome', 'input', 'chat-thread', 'messages', 'message-actions', 'mobile', 'thread-card', 'stats',
    'question-cards', 'tool-approval', 'shared-chat-host', 'graphite-context-surfaces',
  ].map(name => readFile(new URL(`../../src/styles/${name}.css`, import.meta.url), 'utf8')));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><style>${styles.join('\n').replace("@import './chat-thread.css';", '')}
      * { box-sizing: border-box; } body { margin: 0; }
      #mainColumn { display: flex; flex-direction: column; width: calc(100vw - 300px); margin-left: 292px; }
      #workspaceSplit[data-side-open] > #mainColumn { width: calc(100vw - 740px); }
      .chat-thread { display: flex; flex-direction: column; }
    </style><main id="workspaceSplit">
      <header id="graphiteThreadHeader"></header>
      <section id="mainColumn" class="main-column">
        <div id="chatArea" class="chat-thread">
          <div class="msg assistant">A saved reply</div>
          <div class="msg user msg--has-actions">
            <div class="msg-bubble msg-bubble--user-parts"><div class="user-msg-text">continue</div></div>
            <button class="message-actions__trigger" aria-label="Message actions">⋮</button>
          </div>
          <div class="msg user msg--sending">
            <div class="msg-bubble msg-bubble--user-parts"><div class="user-msg-text">continue</div></div>
          </div>
          <div class="msg user msg--has-actions">
            <div class="msg-bubble msg-bubble--user-parts"><div class="user-msg-text">${'longword'.repeat(150)}</div></div>
            <button class="message-actions__trigger" aria-label="Message actions">⋮</button>
          </div>
        </div>
        <div id="toolApprovalHost" class="tool-approval-host" hidden>Allow this tool?</div>
        <div id="questionHost" class="question-host" hidden>Which option should I use?</div>
        <div class="input-bar">
          <div class="input-bar-composer"><div class="input-row"><div class="input-wrap input-wrap--inset-actions">
            <textarea id="msgInput" rows="1" placeholder="Message"></textarea>
          </div></div></div>
          <div class="input-bar-send-stack"><button class="send-btn" aria-label="Send message"></button></div>
        </div><button class="graphite-metrics-trigger">Metrics</button>
      </section>
      <section class="graphite-side-chat" style="width: 220px; min-height: 180px">
        <div class="graphite-chat-panel__scroll"></div>
        <form class="input-bar">
          <div class="input-bar-composer"><div class="input-row"><div class="input-wrap input-wrap--inset-actions">
            <textarea class="composer-textarea" rows="1" placeholder="Ask about this thread"></textarea>
          </div></div></div>
          <div class="input-bar-send-stack"><button class="send-btn" aria-label="Send message"></button></div>
        </form>
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

  for (const [viewport, sideOpen, expected] of [[1440, false, 660], [1728, false, 821], [1440, true, 628], [1100, true, 328]]) {
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

  const promptSpacing = await session.evaluate(`['questionHost', 'toolApprovalHost'].map(id => {
    const prompt = document.getElementById(id);
    const composer = document.querySelector('.input-bar');
    const metrics = document.querySelector('.graphite-metrics-trigger');
    prompt.hidden = false;
    const gap = metrics.getBoundingClientRect().top - prompt.getBoundingClientRect().bottom;
    const composerHidden = getComputedStyle(composer).display === 'none';
    prompt.hidden = true;
    return { id, gap, composerHidden };
  })`);
  for (const { id, gap, composerHidden } of promptSpacing) {
    assert.ok(composerHidden, `${id} should replace the composer`);
    assert.ok(gap > 0, `${id} should have space above Metrics, got ${gap}px`);
  }

  const bubbles = () => session.evaluate(`[...document.querySelectorAll('.msg.user')].map(row => {
    const bubble = row.querySelector('.msg-bubble');
    const trigger = row.querySelector('.message-actions__trigger');
    const { paddingLeft, paddingRight } = getComputedStyle(bubble);
    return { row: row.getBoundingClientRect().toJSON(), bubble: bubble.getBoundingClientRect().toJSON(),
      paddingLeft, paddingRight, trigger: trigger?.getBoundingClientRect().toJSON() };
  })`);
  const resting = await bubbles();
  const [saved, pending, wrapped] = resting;
  assert.equal(saved.bubble.width, pending.bubble.width);
  assert.equal(saved.paddingLeft, saved.paddingRight);
  for (const message of [saved, wrapped]) {
    assert.equal(message.bubble.right, message.row.right);
    assert.ok(message.trigger.left >= message.row.left);
    assert.ok(message.trigger.right < message.bubble.left);
  }
  assert.ok(wrapped.bubble.width <= wrapped.row.width * 0.85);
  assert.ok(wrapped.bubble.height > saved.bubble.height);
  await session.evaluate(`document.querySelector('.message-actions__trigger').focus({ preventScroll: true })`);
  assert.deepEqual(await bubbles(), resting);

  const menus = await session.evaluate(`[...document.querySelectorAll('.message-actions__trigger')].map(trigger => {
    const menu = document.createElement('div');
    menu.className = 'message-actions__menu';
    menu.textContent = 'Copy';
    trigger.after(menu);
    const bounds = menu.getBoundingClientRect().toJSON();
    menu.remove();
    return bounds;
  })`);
  for (const [index, message] of [saved, wrapped].entries()) {
    const menu = menus[index];
    assert.ok(menu.left >= message.row.left && menu.right <= message.row.right);
    assert.ok(menu.left <= message.bubble.left && menu.right > message.trigger.right);
  }

  await session.evaluate(`(() => {
    const transcript = document.querySelector('#chatArea');
    transcript.removeAttribute('id');
    transcript.classList.add('graphite-chat-panel__transcript');
    transcript.style.width = '220px';
    document.documentElement.classList.add('mn-touch');
  })()`);
  for (const message of (await bubbles()).filter(message => message.trigger)) {
    assert.equal(message.trigger.width, 44);
    assert.ok(message.trigger.left >= message.row.left);
    assert.ok(message.trigger.right < message.bubble.left);
  }

  const [main, side] = await session.evaluate(`Array.from(document.querySelectorAll('.input-bar'), bar => {
    const textarea = bar.querySelector('textarea');
    const send = bar.querySelector('.send-btn');
    const field = textarea.getBoundingClientRect();
    const button = send.getBoundingClientRect();
    const bounds = bar.getBoundingClientRect();
    return {
      card: [getComputedStyle(bar).backgroundColor, getComputedStyle(bar).borderRadius],
      field: [getComputedStyle(textarea).fontSize, getComputedStyle(textarea).borderWidth, getComputedStyle(textarea).padding],
      button: [button.width, button.height, getComputedStyle(send).backgroundColor],
      fits: field.bottom <= button.top && button.right <= bounds.right && field.width <= bounds.width,
    };
  })`);
  assert.deepEqual(side, main);
  assert.equal(side.fits, true);
});
