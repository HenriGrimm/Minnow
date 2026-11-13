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
  const styles = await Promise.all(['tokens', 'minnowos-tokens', 'minnowos-shell', 'minnowos-rail', 'graphite-workspace', 'thread-card',
    'settings-page', 'source-control-center', 'models-page', 'brain-page', 'brain-graph', 'scheduler-page',
    'issues', 'dev-server-screen', 'orchestrator-boards', 'product-wiki', 'graphite-apps'].map(name =>
    readFile(new URL(`../../src/styles/${name}.css`, import.meta.url), 'utf8')));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-graphite-sidebar-'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html class="is-electron-shell mn-graphite-workspace mn-graphite-sidebar-open mn-graphite-apps" data-platform="win32">
      <style>${styles.join('\n').replace(/^@import .*;$/gm, '')}
        * { box-sizing: border-box; } body { margin: 0; }
      </style>
      <div class="mn-os">
        <header id="osMenubar" class="mn-os-menubar mn-os-menubar--shell-frameless" data-view="app">
          <div class="mn-os-mb-left"><div class="mn-os-mb-workspace-slot"><button>Project</button></div><button class="mn-os-mb-icon mn-os-mb-chat-toggle" id="sidebarToggle">☰</button></div>
          <div class="mn-os-mb-right">
            <button class="mn-os-mb-icon">1</button><button class="mn-os-mb-icon">2</button>
            <button class="mn-os-mb-icon">3</button><button class="mn-os-mb-icon">4</button>
            <button class="mn-os-mb-icon">5</button><button class="mn-os-mb-icon">6</button>
            <button class="mn-os-mb-icon" id="settings">⚙</button>
          </div>
          <div class="mn-os-mb-window-controls">
            <button class="mn-os-window-btn">−</button><button class="mn-os-window-btn">□</button><button class="mn-os-window-btn" id="close">×</button>
          </div>
        </header>
        <div id="osWorkspace" class="mn-os-workspace">
          <nav id="osAppRail">Workspace navigation</nav>
          <main id="osStage" class="mn-os-stage is-in-app">
            <div id="osAppsLayer" class="mn-os-apps-layer">
              <div class="mn-os-app-layer is-active" id="code">
                <header id="graphiteThreadHeader" data-app-titlebar><h1 class="graphite-thread-title">Workspace content</h1>
                  <div class="graphite-thread-header__actions"><button id="threadAction">Thread action</button></div>
                </header>
              </div>
              <div class="mn-os-app-layer settings-page" id="settingsApp">
                <header class="settings-page-header" data-app-titlebar>
                  <h1 class="settings-graphite-title">Settings</h1><button>Back</button>
                </header>
              </div>
              <div class="mn-os-app-layer" id="sourceControl">
                <div class="scc-root">
                  <header class="scc-head" data-app-titlebar>
                    <div class="scc-head__identity">Repository</div>
                    <div class="scc-head__actions"><button>Search</button></div>
                  </header>
                </div>
              </div>
              <div class="mn-os-app-layer models-page" id="models">
                <header class="models-page-header" data-app-titlebar><h1>Models</h1>
                  <div class="models-header-status">No model loaded</div><button>Inspector</button>
                </header>
              </div>
              <div class="mn-os-app-layer scheduler-page" id="scheduler">
                <header class="scheduler-header" data-app-titlebar>
                  <div class="scheduler-header__brand">Scheduler</div><button>New job</button>
                </header>
              </div>
              <div class="mn-os-app-layer issues-page" id="issues">
                <div class="issues-shell"><header class="issues-header" data-app-titlebar>
                  <div class="issues-header__brand">Issues</div><button>New issue</button>
                </header></div>
              </div>
              <div class="mn-os-app-layer brain-page is-graph-canvas-bg" id="brain">
                <div class="brain-page-chrome"><div class="brain-page-body">
                  <nav class="brain-rail brain-overlay-surface">Brain</nav>
                  <div class="brain-stage">
                    <div class="brain-content"><section class="brain-section brain-section--graph is-active">
                      <div class="brain-graph-stage brain-graph-overlays">
                        <div class="brain-graph-toolbar brain-overlay-card" data-app-titlebar>
                          <div class="brain-graph-toolbar__group brain-graph-toolbar__search">Search</div><button>New page</button>
                        </div>
                      </div>
                    </section></div>
                    <div class="brain-inspector is-open">Inspector</div>
                  </div>
                </div></div>
              </div>
              <div class="mn-os-app-layer" id="devServers">
                <div class="dev-server-screen"><header class="dev-server-screen__toolbar" data-app-titlebar>
                  <strong>Dev servers</strong><button>Add server</button>
                </header></div>
              </div>
              <div class="mn-os-app-layer" id="boards">
                <div class="chat-area--orchestrator-boards">
                  <div class="ov2"><header class="ov2__stage-header" data-app-titlebar><h1>Boards</h1><button>New board</button></header>
                    <aside class="ov2__list"><div class="ov2__list-head">Boards</div></aside>
                    <section class="ov2__board"><header class="board-header">Selected board</header></section>
                  </div>
                </div>
              </div>
            </div>
            <section class="product-wiki hidden" id="wiki">
              <header class="product-wiki__header" data-app-titlebar><strong>Minnow wiki</strong>
                <label class="product-wiki__search"><input aria-label="Search wiki"></label><button>Close wiki</button>
              </header>
            </section>
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

  const { start, during, end, withoutThread, appHeaders } = await session.evaluate(`(() => {
    const stage = document.getElementById('osStage');
    const rail = document.getElementById('osAppRail');
    const bounds = selector => document.querySelector(selector).getBoundingClientRect();
    const measure = () => {
      const { left, right, top } = stage.getBoundingClientRect();
      const controls = bounds('.mn-os-mb-window-controls');
      const divider = getComputedStyle(document.querySelector('.mn-os-mb-window-controls'), '::before');
      const close = bounds('#close');
      const dragStrip = getComputedStyle(document.getElementById('graphiteThreadHeader'), '::before');
      const menubar = document.getElementById('osMenubar');
      const titlebarHit = document.elementFromPoint((rail.getBoundingClientRect().right + controls.left) / 2, top / 2);
      return { left, right, top, railRight: rail.getBoundingClientRect().right,
        coversRail: stage.contains(document.elementFromPoint(left + 16, 120)),
        controls: controls.toJSON(),
        dividerWidth: divider.width,
        minimizeLeft: bounds('.mn-os-mb-window-controls button').left,
        closeClickable: document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2)?.id === 'close',
        sidebarToggle: bounds('#sidebarToggle').toJSON(),
        sidebarToggleRegion: getComputedStyle(document.getElementById('sidebarToggle')).getPropertyValue('app-region'),
        gapDraggable: titlebarHit === menubar && getComputedStyle(menubar).getPropertyValue('app-region') === 'drag',
        threadActionRight: bounds('#threadAction').right, settingsRight: bounds('#settings').right,
        dragStripRegion: dragStrip.getPropertyValue('app-region'),
        dragStripRight: bounds('#graphiteThreadHeader').right - parseFloat(dragStrip.right),
        threadActionRegion: getComputedStyle(document.getElementById('threadAction')).getPropertyValue('app-region') };
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
    const withoutThread = measure();
    document.getElementById('code').classList.remove('is-active');
    const appHeaders = ['settingsApp', 'sourceControl', 'models', 'scheduler', 'issues', 'brain', 'devServers', 'boards', 'wiki'].flatMap(id => [true, false].map(sidebarOpen => {
      const app = document.getElementById(id);
      document.documentElement.classList.toggle('mn-graphite-sidebar-open', sidebarOpen);
      app.classList.toggle(id === 'wiki' ? 'hidden' : 'is-active', id !== 'wiki');
      const frame = measure();
      const header = app.querySelector('[data-app-titlebar]');
      const action = header.querySelector('button');
      const actionRect = action.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const hit = document.elementFromPoint(actionRect.x + actionRect.width / 2, actionRect.y + actionRect.height / 2);
      const snapshot = { ...frame, id, sidebarOpen, header: headerRect.toJSON(), action: actionRect.toJSON(), actionClickable: hit === action,
        headerColor: getComputedStyle(header).backgroundColor, stageColor: getComputedStyle(stage).backgroundColor,
        firstShellAction: bounds('.mn-os-mb-right button').left,
        topStrip: getComputedStyle(document.getElementById('osWorkspace'), '::before').content,
        dragRegion: getComputedStyle(header, '::before').getPropertyValue('app-region'),
        actionRegion: getComputedStyle(action).getPropertyValue('app-region') };
      app.classList.toggle(id === 'wiki' ? 'hidden' : 'is-active', id === 'wiki');
      return snapshot;
    }));
    return { start, during, end, withoutThread, appHeaders };
  })()`);

  assert.equal(start.left, start.railRight);
  assert.equal(start.dragStripRegion, 'drag');
  assert.ok(start.dragStripRight <= start.controls.left);
  assert.equal(start.threadActionRegion, 'no-drag');
  assert.equal(end.dragStripRegion, 'drag');
  assert.equal(end.railRight, 0);
  assert.equal(end.left, 8);
  assert.equal(end.top, start.top);
  assert.equal(end.controls.right, 1440 - 22);
  assert.ok(end.settingsRight < end.controls.left);
  assert.ok(start.threadActionRight < start.controls.left);
  assert.ok(withoutThread.top >= withoutThread.controls.bottom);
  assert.ok(withoutThread.gapDraggable, 'the titlebar above apps without a thread header should be draggable');
  assert.deepEqual(withoutThread.sidebarToggle, start.sidebarToggle);
  assert.equal(withoutThread.sidebarToggleRegion, 'no-drag');
  for (const frame of [start, ...during, end, withoutThread, ...appHeaders]) {
    assert.deepEqual(frame.controls, end.controls);
    assert.equal(frame.dividerWidth, '1px');
    assert.ok(frame.minimizeLeft > frame.controls.left + 1);
    assert.ok(frame.closeClickable);
  }
  for (const frame of appHeaders) {
    assert.equal(frame.top, start.top);
    assert.equal(frame.header.top, start.top, frame.id);
    assert.ok(frame.controls.top >= frame.header.top && frame.controls.bottom <= frame.header.bottom);
    assert.ok(frame.action.right < frame.controls.left);
    assert.ok(frame.actionClickable, frame.id);
    assert.equal(frame.dragRegion, 'drag');
    assert.equal(frame.actionRegion, 'no-drag');
    assert.equal(frame.topStrip, 'none');
    assert.equal(frame.headerColor, frame.stageColor);
    if (frame.sidebarOpen) assert.deepEqual(frame.sidebarToggle, start.sidebarToggle);
    else {
      assert.ok(frame.sidebarToggle.right < frame.action.left);
      assert.ok(frame.action.right < frame.firstShellAction);
    }
  }
  let previous = start;
  for (const frame of during) {
    assert.ok(frame.left < previous.left && frame.left > end.left, JSON.stringify(frame));
    assert.equal(frame.top, start.top);
    assert.equal(frame.right, start.right);
    assert.equal(frame.railRight, start.railRight);
    assert.ok(frame.coversRail);
    previous = frame;
  }

  const detached = await session.evaluate(`(() => {
    const html = document.documentElement;
    html.dataset.appWindow = 'models';
    html.classList.remove('mn-graphite-workspace', 'mn-graphite-sidebar-open');
    document.getElementById('osAppRail').hidden = true;
    const models = document.getElementById('models');
    models.classList.add('is-active');
    const header = models.querySelector('header').getBoundingClientRect();
    const caption = document.getElementById('close').getBoundingClientRect();
    const action = models.querySelector('button').getBoundingClientRect();
    return { top: header.top, captionWithinHeader: caption.top >= header.top && caption.bottom <= header.bottom,
      actionClear: action.right < caption.left };
  })()`);
  assert.deepEqual(detached, { top: start.top, captionWithinHeader: true, actionClear: true });
});
