import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';

test('Code and Automations lay out their chat transcripts', { timeout: 30_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-graphite-layout-'));
  const styles = await Promise.all([
    'tokens', 'code-chrome', 'input', 'chat-thread', 'messages', 'message-actions', 'mobile', 'thread-card', 'stats',
    'question-cards', 'tool-approval', 'shared-chat-host', 'graphite-context-surfaces', 'sidebar', 'sub-agent-drawer', 'mobile-app', 'automations',
  ].map(name => readFile(new URL(`../../src/styles/${name}.css`, import.meta.url), 'utf8')));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><style>${styles.join('\n').replace("@import './chat-thread.css';", '')}
      * { box-sizing: border-box; } body { margin: 0; }
      #mainColumn { display: flex; flex-direction: column; width: calc(100vw - 300px); margin-left: 292px; }
      #workspaceSplit[data-side-open] > #mainColumn { width: calc(100vw - 740px); }
    </style><main id="workspaceSplit">
      <header id="graphiteThreadHeader"></header>
      <section id="mainColumn" class="main-column">
        <div class="chat-viewport">
        <div id="chatArea" class="chat-area chat-thread">
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
        <div class="composer-notices">
          <div class="composer-run-status" hidden>Working</div>
          <section class="managed-chat-requests managed-chat-requests--docked" hidden>Waiting for interrupted work to stop…</section>
          <div id="toolApprovalHost" class="tool-approval-host" hidden>Allow this tool?</div>
          <div id="questionHost" class="question-host" hidden>Which option should I use?</div>
        </div>
        </div>
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

  await session.client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, mobile: false, deviceScaleFactor: 1 });
  await session.evaluate(`document.querySelector('#chatArea').insertAdjacentHTML('beforeend', \`
    <section class="chat-turn-changes">
      <div class="chat-turn-changes__header">
        <div class="chat-turn-changes__heading">
          <div class="chat-turn-changes__summary">
            <strong>Edited 1 file</strong>
            <div class="chat-turn-changes__counts"><span class="chat-turn-changes__add">+195</span><span class="chat-turn-changes__del">−17</span></div>
          </div>
          <span class="chat-turn-changes__branch"><span class="icon-svg" aria-hidden="true">⑂</span>backend/modularity-and-read-budget</span>
        </div>
        <div class="chat-turn-changes__controls">
          <button class="chat-turn-changes__undo" aria-label="Undo last agent turn" hidden><span class="icon-svg" aria-hidden="true">↶</span></button>
          <div class="chat-turn-changes__actions chat-turn-changes__plan-actions">
            <button class="chat-turn-changes__action"><span class="icon-svg" aria-hidden="true">▤</span>Open plan</button>
            <button class="chat-turn-changes__action chat-turn-changes__action--primary"><span class="icon-svg" aria-hidden="true">◇</span>Build here</button>
            <button class="chat-turn-changes__action" hidden><span class="icon-svg" aria-hidden="true">▥</span>Orchestrate</button>
          </div>
          <div class="chat-turn-changes__actions" hidden>
            <button class="chat-turn-changes__action" hidden><span class="icon-svg" aria-hidden="true">⑂</span>Create PR</button>
            <button class="chat-turn-changes__action chat-turn-changes__action--primary" hidden><span class="icon-svg" aria-hidden="true">◈</span>Commit</button>
          </div>
        </div>
      </div>
      <div class="chat-turn-changes__file">
        <span class="chat-turn-changes__file-icon" aria-hidden="true">▤</span>
        <button class="chat-turn-changes__path">documentation/plans/<span class="chat-turn-changes__base">coltiva-repository-split.md</span></button>
        <span class="chat-turn-changes__counts"><span class="chat-turn-changes__add">+195</span><span class="chat-turn-changes__del">−17</span></span>
        <span class="chat-turn-changes__file-chevron" aria-hidden="true">›</span>
      </div>
    </section>\`)`);
  const measureChanges = (width, allActions = false) => session.evaluate(`(() => {
    const card = document.querySelector('.chat-turn-changes');
    card.style.width = '${width}px';
    if (${allActions}) card.querySelectorAll('[hidden]').forEach(element => { element.hidden = false; });
    const heading = card.querySelector('.chat-turn-changes__heading');
    const branch = card.querySelector('.chat-turn-changes__branch');
    const controls = card.querySelector('.chat-turn-changes__controls');
    const range = document.createRange();
    range.selectNodeContents(branch.lastChild);
    const measure = element => element.getBoundingClientRect().toJSON();
    return {
      card: measure(card), heading: measure(heading), summary: measure(heading.firstElementChild),
      branch: measure(branch), controls: measure(controls), file: measure(card.lastElementChild),
      branchLines: range.getClientRects().length,
      buttons: [...controls.querySelectorAll('button')].filter(button => button.getClientRects().length).map(measure),
    };
  })()`);
  for (const width of [660, 540]) {
    const { heading, summary, branch, controls, branchLines } = await measureChanges(width);
    assert.ok(branch.top >= summary.bottom);
    assert.equal(branchLines, 1);
    assert.ok(heading.right <= controls.left);
    assert.ok(controls.top < heading.bottom && controls.bottom > heading.top);
  }
  const narrowChanges = await measureChanges(328);
  assert.ok(narrowChanges.controls.top >= narrowChanges.heading.bottom);
  assert.equal(narrowChanges.controls.left, narrowChanges.heading.left);
  assert.ok(narrowChanges.file.top >= narrowChanges.controls.bottom);
  assert.equal(narrowChanges.branchLines, 1);
  assert.equal(narrowChanges.buttons.length, 2);
  assert.equal(new Set(narrowChanges.buttons.map(button => button.top)).size, 1);
  assert.equal(new Set(narrowChanges.buttons.map(button => button.height)).size, 1);
  const smallestChanges = await measureChanges(220, true);
  assert.ok(smallestChanges.controls.top >= smallestChanges.heading.bottom);
  assert.equal(smallestChanges.buttons.length, 6);
  assert.ok(new Set(smallestChanges.buttons.map(button => button.top)).size > 1);
  assert.ok(smallestChanges.buttons.every(button => button.left >= smallestChanges.card.left && button.right <= smallestChanges.card.right));
  await session.evaluate(`document.querySelectorAll('.chat-turn-changes__controls button').forEach(button => { button.hidden = true; })`);
  assert.equal((await measureChanges(220)).controls.height, 0);
  await session.evaluate(`document.querySelector('.chat-turn-changes').remove()`);

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

  await session.evaluate(`(() => {
    document.documentElement.classList.remove('mn-touch');
    const transcript = document.querySelector('.graphite-chat-panel__transcript');
    transcript.classList.remove('graphite-chat-panel__transcript');
    transcript.id = 'chatArea';
    transcript.style.width = '';
    const column = document.querySelector('#mainColumn');
    column.style.height = '650px';
    column.querySelector('.chat-viewport').insertAdjacentHTML('afterbegin',
      '<details class="chat-turn-todos chat-todo-panel" open><summary class="chat-turn-todos__header">Todo list</summary>' +
      '<ul class="chat-turn-todos__list"><li>Review the checklist</li></ul></details>');
  })()`);
  const measureChecklist = () => session.evaluate(`(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return { panel: rect('.chat-todo-panel'), composer: rect('#mainColumn > .input-bar'),
      status: rect('.composer-run-status'), transcript: rect('#chatArea'), column: rect('#mainColumn'),
      tracks: getComputedStyle(document.querySelector('.chat-viewport')).gridTemplateColumns };
  })()`);
  for (const width of [1440, 1100]) {
    await session.client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, mobile: false, deviceScaleFactor: 1 });
    for (const running of [false, true]) {
      await session.evaluate(`document.querySelector('.composer-run-status').hidden = ${!running}`);
      const { panel, composer, status } = await measureChecklist();
      assert.ok(Math.abs(panel.bottom - composer.top) <= 1, 'checklist touches the composer');
      assert.ok(Math.abs(panel.left - composer.left - (composer.right - panel.right)) <= 1, 'checklist is centered');
      assert.ok(panel.width > 0.8 * composer.width && panel.width < composer.width);
      if (running) assert.ok(status.bottom <= panel.top);
    }
  }

  await session.evaluate("document.querySelector('.chat-todo-panel').open = false");
  const collapsed = await measureChecklist();
  assert.ok(Math.abs(collapsed.panel.bottom - collapsed.composer.top) <= 1);
  await session.evaluate("document.querySelector('.chat-todo-panel').open = true");
  for (const [width, mobile] of [[1100, false], [1920, false], [390, true]]) {
    await session.client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, mobile: false, deviceScaleFactor: 1 });
    await session.evaluate(`(() => {
      const column = document.getElementById('mainColumn');
      column.parentElement.removeAttribute('data-side-open');
      column.classList.toggle('m-thread', ${mobile});
      column.style.width = ${mobile} ? '100%' : '';
      column.style.marginInlineStart = ${mobile} ? '0' : '';
    })()`);
    for (const selector of ['.managed-chat-requests', '#toolApprovalHost', '#questionHost']) {
      const ordered = await session.evaluate(`(() => {
        const notice = document.querySelector(${JSON.stringify(selector)});
        notice.hidden = false;
        const panel = document.querySelector('.chat-todo-panel').getBoundingClientRect();
        const rect = notice.getBoundingClientRect();
        notice.hidden = true;
        return rect.height > 0 && panel.height > 0 && rect.bottom <= panel.top;
      })()`);
      assert.ok(ordered, `${selector} stays above the checklist at ${width}px`);
    }
  }
  await session.evaluate(`(() => {
    const column = document.getElementById('mainColumn');
    column.classList.remove('m-thread');
    column.style.width = '';
    column.style.marginInlineStart = '';
  })()`);
  await session.evaluate("document.getElementById('workspaceSplit').removeAttribute('data-side-open')");
  await session.client.send('Emulation.setDeviceMetricsOverride', { width: 1579, height: 900, mobile: false, deviceScaleFactor: 1 });
  const belowBreakpoint = await measureChecklist();
  assert.ok(Math.abs(belowBreakpoint.panel.bottom - belowBreakpoint.composer.top) <= 1);
  let previousPanelWidth = 0;
  for (const width of [1580, 2200, 3840]) {
    await session.client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, mobile: false, deviceScaleFactor: 1 });
    const wide = await measureChecklist();
    const { panel, transcript, composer, column } = wide;
    assert.ok(panel.width >= 191 && panel.width <= 352, JSON.stringify(wide));
    assert.ok(transcript.left - panel.right >= 32 && transcript.left - panel.right <= 64, JSON.stringify(wide));
    assert.ok(panel.left - column.left >= 32);
    assert.ok(panel.width >= previousPanelWidth);
    previousPanelWidth = panel.width;
    assert.ok(Math.abs(transcript.left - composer.left) <= 1);
  }
  const { root } = await session.client.send('DOM.getDocument');
  const { nodeId } = await session.client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.chat-todo-panel > summary' });
  await session.client.send('CSS.enable');
  await session.client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  const corner = await session.evaluate(`(() => {
    const card = document.querySelector('.chat-todo-panel');
    const { left, top } = card.getBoundingClientRect();
    const header = card.querySelector('summary');
    return { hovered: header.matches(':hover'), overflow: getComputedStyle(card).overflow,
      topRadius: parseFloat(getComputedStyle(header).borderTopLeftRadius),
      hit: card.contains(document.elementFromPoint(left + 1, top + 1)) };
  })()`);
  assert.deepEqual(corner, { hovered: true, overflow: 'clip', topRadius: 14, hit: false });

  await session.evaluate(`(() => {
    document.getElementById('workspaceSplit').remove();
    document.body.insertAdjacentHTML('beforeend', '<section class="auto-root" style="height: 860px"><div class="auto-job">' +
      '<header class="auto-job__bar">Build check</header><div class="auto-job__body">' +
      '<aside class="auto-job__list">Runs</aside><div class="auto-job__run"><div class="auto-transcript">' +
      '<div class="auto-transcript__body chat-thread chat-thread--bubble-prompts" data-chat-view="compact">' +
      '<div class="msg user"><div class="msg-bubble">Check the build</div></div>' +
      '<button class="chat-work" aria-expanded="true">Worked</button>' +
      '<div class="tool-call-msg chat-step"><details class="tool-call-details"><summary class="tool-call-summary">Run</summary></details></div>' +
      '<div class="msg assistant"><div class="msg-bubble msg-bubble--md"><p>Build passed.</p></div></div>' +
      '<div class="chat-reply-foot"><button class="chat-reply-foot__btn">Copy</button></div>' +
      '</div></div><footer class="auto-runfoot">Done<button class="auto-btn">Continue in Code</button></footer>' +
      '</div><aside class="auto-job__rail">Settings</aside></div></div></section>');
  })()`);
  for (const width of [1024, 390]) {
    await session.client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, mobile: false, deviceScaleFactor: 1 });
    const { gaps, prompt, thread, toolBorder, lead } = await session.evaluate(`(() => {
      const body = document.querySelector('.auto-transcript__body');
      const prompt = body.querySelector('.msg.user .msg-bubble');
      const rows = [...body.children].map(row => row.getBoundingClientRect());
      return {
        gaps: rows.slice(1).map((row, i) => row.top - rows[i].bottom),
        prompt: prompt.getBoundingClientRect().toJSON(),
        thread: body.getBoundingClientRect().toJSON(),
        toolBorder: getComputedStyle(body.querySelector('.tool-call-details')).borderTopColor,
        lead: getComputedStyle(prompt, '::before').content,
      };
    })()`);
    assert.ok(gaps.every(gap => gap >= 8), `Automation rows should have room at ${width}px: ${gaps}`);
    assert.equal(prompt.right, thread.right);
    assert.ok(prompt.width < thread.width / 2);
    assert.equal(lead, 'none');
    assert.equal(toolBorder, 'rgba(0, 0, 0, 0)');
  }

  await session.client.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, mobile: false, deviceScaleFactor: 1 });
  for (const long of [false, true]) {
    const { footerGap, scrolls, rootScrolls } = await session.evaluate(`(() => {
      const root = document.querySelector('.auto-root');
      const transcript = root.querySelector('.auto-transcript');
      const footer = root.querySelector('.auto-runfoot');
      if (${long}) transcript.querySelector('.msg.assistant p').textContent = 'Build passed. '.repeat(1000);
      return {
        footerGap: root.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom,
        scrolls: transcript.scrollHeight > transcript.clientHeight,
        rootScrolls: root.scrollHeight > root.clientHeight,
      };
    })()`);
    assert.equal(footerGap, 0);
    assert.equal(scrolls, long);
    assert.equal(rootScrolls, false);
  }
});
