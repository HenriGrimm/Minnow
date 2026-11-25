import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';

test('Graphite titlebar layout and hit targets across sidebar states and platforms', { timeout: 30_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);
  const styles = await Promise.all(['tokens', 'minnowos-tokens', 'minnowos-shell', 'minnowos-rail', 'sidebar', 'graphite-workspace', 'thread-card',
    'settings-page', 'source-control-center', 'models-page', 'brain-page', 'brain-memories', 'scheduler-page',
    'issues', 'dev-server-screen', 'product-wiki', 'graphite-apps', 'surfaces'].map(name =>
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
          <nav id="osAppRail">
            <div class="mn-os-app-rail__nav" style="height: 190px">Workspace navigation</div>
            <aside class="chat-sidebar"><div class="chat-sidebar-main"><div class="chat-list">
              <div class="chat-list-section-head"><span>Today</span>
                <button type="button" class="chat-list-section-action">Archive 3 finished</button>
              </div>
              ${'<div class="chat-item-row">Saved chat</div>'.repeat(30)}
            </div></div></aside>
            <div id="chatSidebarResizer" class="sidebar-resizer sidebar-resizer--chat" tabindex="0"></div>
            <div class="mn-graphite-auxiliary" style="height: 40px">Sidebar footer</div>
          </nav>
          <main id="osStage" class="mn-os-stage is-in-app">
            <div id="osAppsLayer" class="mn-os-apps-layer">
              <div class="mn-os-app-layer is-active" id="code">
                <header id="graphiteThreadHeader" data-app-titlebar><h1 class="graphite-thread-title">Workspace content</h1>
                  <div class="graphite-thread-header__actions">
                    <button id="threadAction">Thread action</button>
                    <div class="graphite-thread-header__panel-toggles"><button id="btnSurfaceBottom">Bottom panel</button></div>
                  </div>
                </header>
                <div id="devServerWorkbench" class="workspace-split graphite-surfaces" data-surface-side="true" hidden>
                  <div class="main-column">
                    <header class="dev-server-screen__toolbar"><strong>Dev servers</strong><button id="addServer">Add server</button></header>
                  </div>
                  <section class="graphite-surface-panel graphite-surface-panel--side">
                    <header class="graphite-surface-header">
                      <span>Preview</span><div class="graphite-surface-controls"><button id="previewControl">Hide panel</button></div>
                    </header>
                  </section>
                </div>
              </div>
              <div class="mn-os-app-layer settings-page" id="settingsApp">
                <header class="settings-page-header" data-app-titlebar>
                  <h1 class="settings-graphite-title">Settings</h1><button>Back</button>
                </header>
              </div>
              <div class="mn-os-app-layer" id="sourceControl">
                <div class="scc-root">
                  <header class="scc-head" data-app-titlebar>
                    <div class="scc-head__identity"><button>Back</button><h1 class="scc-head__title">Source Control</h1>
                      <div class="scc-head__context">
                        <button class="scc-btn scc-head__repo-switch">Frontend</button>
                        <button class="scc-btn scc-head__worktree">Local</button>
                        <button class="scc-btn scc-head__branch">main</button>
                        <span class="scc-head__forge">org/frontend</span>
                      </div>
                      <div class="scc-head__drag-gap" aria-hidden="true"></div>
                    </div>
                    <div class="scc-head__sync"><button class="scc-btn">Fetch</button></div>
                    <div class="scc-head__actions"><button class="scc-btn scc-head__palette-btn" aria-label="Commands">⌕</button></div>
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
              <div class="mn-os-app-layer issues-page is-open" id="issuesView">
                <div class="issues-shell"><header class="issues-header" data-app-titlebar>
                  <div class="issues-header__brand">Issues</div><button>New issue</button>
                </header></div>
              </div>
              <div class="mn-os-app-layer brain-page" id="brain">
                <div class="brain-page-chrome">
                  <header class="brain-page-header brain-overlay-surface" data-app-titlebar>
                    <div class="brain-page-header__main"><h1 class="brain-page-header__title">Memories</h1></div>
                    <div class="brain-page-header__actions"><button>Add memory</button></div>
                  </header>
                  <div class="brain-page-body">
                    <nav class="brain-rail brain-overlay-surface">Brain</nav>
                    <div class="brain-stage">
                      <div class="brain-content"><section class="brain-section brain-section--memories is-active">Memories</section></div>
                    </div>
                  </div>
                </div>
              </div>
              <div class="mn-os-app-layer" id="devServers">
                <div class="dev-server-screen"><header class="dev-server-screen__toolbar" data-app-titlebar>
                  <strong>Dev servers</strong><button>Add server</button>
                </header></div>
              </div>

            </div>
            <section class="product-wiki hidden" id="wiki">
              <header class="product-wiki__header" data-app-titlebar>
                <div class="product-wiki__identity"><button class="back-to-chat" aria-label="Back to chat">←</button><strong>Minnow wiki</strong></div>
                <label class="product-wiki__search"><input aria-label="Search wiki"></label>
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

  const measureArchiveAction = () => session.evaluate(`(() => {
    const list = document.querySelector('.chat-list');
    const action = list.querySelector('.chat-list-section-action');
    action.focus({ preventScroll: true });
    const { top, height } = action.getBoundingClientRect();
    const style = getComputedStyle(action);
    const outline = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    action.blur();
    return { scrolls: list.scrollHeight > list.clientHeight, height,
      clearsTop: top - outline >= list.getBoundingClientRect().top };
  })()`);
  const desktopArchive = await measureArchiveAction();
  await session.client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const touchArchive = await measureArchiveAction();
  await session.client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  assert.ok(desktopArchive.scrolls && desktopArchive.clearsTop, JSON.stringify(desktopArchive));
  assert.ok(touchArchive.height >= 44 && touchArchive.clearsTop, JSON.stringify(touchArchive));

  const toastLayer = await session.evaluate(`(() => {
    const auxiliary = document.querySelector('.mn-graphite-auxiliary');
    const footer = document.createElement('div');
    footer.className = 'mn-graphite-sidebar-footer';
    footer.innerHTML = '<div class="chat-list-views"><button class="chat-list-view">Archive</button>' +
      '<div class="chat-list-toast"><span class="chat-list-toast__text">Chat archived.</span>' +
      '<button class="chat-list-toast__undo">Undo</button></div></div>';
    const previous = [...auxiliary.childNodes];
    auxiliary.replaceChildren(footer);
    const toast = footer.querySelector('.chat-list-toast');
    const undo = toast.querySelector('button');
    const { left, top, width, height } = undo.getBoundingClientRect();
    const x = left + width / 2;
    const y = top + height / 2;
    const layers = document.elementsFromPoint(x, y);
    const result = {
      overlapsChatList: layers.some(element => element.matches('.chat-list')),
      undoClickable: layers[0] === undo,
      layers: layers.map(element => element.className),
    };
    auxiliary.replaceChildren(...previous);
    return result;
  })()`);
  assert.ok(toastLayer.overlapsChatList && toastLayer.undoClickable, JSON.stringify(toastLayer));

  const grip = await session.evaluate(`(() => {
    const rail = document.getElementById('osAppRail').getBoundingClientRect();
    const resizer = document.getElementById('chatSidebarResizer');
    const target = resizer.getBoundingClientRect();
    resizer.classList.add('dragging');
    const style = getComputedStyle(resizer, '::after');
    const gripY = target.top + parseFloat(style.top) + parseFloat(style.marginTop) + parseFloat(style.height) / 2;
    resizer.classList.remove('dragging');
    const targetX = target.left + target.width / 2;
    const toggle = document.getElementById('sidebarToggle');
    const toggleBounds = toggle.getBoundingClientRect();
    return {
      gripY, sidebarMidpoint: (rail.top + rail.bottom) / 2,
      targetRight: target.right, sidebarRight: rail.right,
      gripDraggable: document.elementFromPoint(targetX, (rail.top + rail.bottom) / 2) === resizer,
      toggleClickable: toggle.contains(document.elementFromPoint(
        toggleBounds.left + toggleBounds.width / 2,
        toggleBounds.top + toggleBounds.height / 2,
      )),
    };
  })()`);
  assert.ok(Math.abs(grip.gripY - grip.sidebarMidpoint) < 1, 'resize grip should align with the full sidebar midpoint');
  assert.equal(grip.targetRight, grip.sidebarRight);
  assert.ok(grip.gripDraggable);
  assert.ok(grip.toggleClickable);

  const { start, during, end, movingToggle, withoutThread, devServerLayouts, appHeaders } = await session.evaluate(`(() => {
    const stage = document.getElementById('osStage');
    const rail = document.getElementById('osAppRail');
    const bounds = selector => document.querySelector(selector).getBoundingClientRect();
    const measure = () => {
      // Mirror the shell's ResizeObserver measurement in this CSS-only fixture.
      document.querySelector('.mn-os').style.setProperty('--mn-titlebar-measured-navigation-width', bounds('.mn-os-mb-left').width + 'px');
      const { left, right, top } = stage.getBoundingClientRect();
      const controls = bounds('.mn-os-mb-window-controls');
      const divider = getComputedStyle(document.querySelector('.mn-os-mb-window-controls'), '::before');
      const close = bounds('#close');
      const dragStrip = getComputedStyle(document.getElementById('graphiteThreadHeader'), '::before');
      const bottomToggle = document.getElementById('btnSurfaceBottom');
      const bottomToggleBounds = bottomToggle.getBoundingClientRect();
      const threadActions = getComputedStyle(bottomToggle.closest('.graphite-thread-header__actions'));
      const menubar = document.getElementById('osMenubar');
      const titlebarHit = document.elementFromPoint((rail.getBoundingClientRect().right + controls.left) / 2, top / 2);
      return { left, right, top, railRight: rail.getBoundingClientRect().right,
        coversRail: stage.contains(document.elementFromPoint(left + 16, 120)),
        controls: controls.toJSON(),
        dividerWidth: divider.width,
        minimizeLeft: bounds('.mn-os-mb-window-controls button').left,
        closeClickable: document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2)?.id === 'close',
        sidebarToggle: bounds('#sidebarToggle').toJSON(),
        threadTitleLeft: bounds('.graphite-thread-title').left,
        sidebarToggleRegion: getComputedStyle(document.getElementById('sidebarToggle')).getPropertyValue('app-region'),
        gapDraggable: titlebarHit === menubar && getComputedStyle(menubar).getPropertyValue('app-region') === 'drag',
        threadActionRight: bounds('#threadAction').right, settingsRight: bounds('#settings').right,
        menubarRegion: getComputedStyle(menubar).getPropertyValue('app-region'),
        dragStripRegion: dragStrip.getPropertyValue('app-region'),
        dragStripLeft: bounds('#graphiteThreadHeader').left + parseFloat(dragStrip.left),
        dragStripRight: bounds('#graphiteThreadHeader').right - parseFloat(dragStrip.right),
        threadActionsPosition: threadActions.position,
        threadActionsRegion: threadActions.getPropertyValue('app-region'),
        bottomToggleClickable: document.elementFromPoint(
          bottomToggleBounds.left + bottomToggleBounds.width / 2,
          bottomToggleBounds.top + bottomToggleBounds.height / 2,
        ) === bottomToggle,
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
    const menubar = document.getElementById('osMenubar');
    menubar.classList.add('mn-graphite-menubar--moving');
    const movingToggle = measure();
    menubar.classList.remove('mn-graphite-menubar--moving');
    document.getElementById('graphiteThreadHeader').hidden = true;
    document.documentElement.classList.add('mn-graphite-sidebar-open');
    const withoutThread = measure();
    const workbench = document.getElementById('devServerWorkbench');
    workbench.hidden = false;
    const devServerLayouts = [true, false].flatMap(sidebarOpen => ['', 'side'].map(maximized => {
      document.documentElement.classList.toggle('mn-graphite-sidebar-open', sidebarOpen);
      workbench.dataset.surfaceMax = maximized;
      const clickable = id => {
        const button = document.getElementById(id);
        const { x, y, width, height } = button.getBoundingClientRect();
        return width > 0 && button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      };
      return {
        sidebarOpen, maximized,
        previewTop: bounds('.graphite-surface-header').top,
        captionBottom: bounds('.mn-os-mb-window-controls').bottom,
        closeClickable: clickable('close'),
        previewControlClickable: clickable('previewControl'),
        addServerClickable: clickable('addServer'),
      };
    }));
    workbench.hidden = true;
    document.getElementById('code').classList.remove('is-active');
    const appHeaders = ['settingsApp', 'issuesView', 'sourceControl', 'models', 'scheduler', 'brain', 'devServers', 'wiki'].flatMap(id => [true, false].map(sidebarOpen => {
      const app = document.getElementById(id);
      document.documentElement.classList.toggle('mn-graphite-sidebar-open', sidebarOpen);
      app.classList.toggle(id === 'wiki' ? 'hidden' : 'is-active', id !== 'wiki');
      const frame = measure();
      const header = app.querySelector('[data-app-titlebar]');
      const action = header.querySelector('button');
      const actionRect = action.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const hit = document.elementFromPoint(actionRect.x + actionRect.width / 2, actionRect.y + actionRect.height / 2);
      const headerStrip = getComputedStyle(header, '::before');
      const gap = header.querySelector('.scc-head__drag-gap');
      const gapRect = gap?.getBoundingClientRect();
      const dragLeft = gapRect?.left ?? headerRect.left + parseFloat(headerStrip.left);
      const sourceControlDrag = gapRect && {
        cachedIssuesHasLayout: document.getElementById('issuesView').getClientRects().length > 0,
        coveredControls: [...header.querySelectorAll('button')].filter(button => {
          const rect = button.getBoundingClientRect();
          return rect.left < gapRect.right && rect.right > gapRect.left;
        }).length,
        headerRegion: headerStrip.getPropertyValue('app-region'),
        width: gapRect.width,
      };
      const snapshot = { ...frame, id, sidebarOpen, header: headerRect.toJSON(), action: actionRect.toJSON(), actionClickable: hit === action,
        headerColor: getComputedStyle(header).backgroundColor, stageColor: getComputedStyle(stage).backgroundColor,
        firstShellAction: bounds('.mn-os-mb-right button').left,
        topStrip: getComputedStyle(document.getElementById('osWorkspace'), '::before').content,
        dragRegion: (gap ? getComputedStyle(gap) : headerStrip).getPropertyValue('app-region'),
        dragLeft, sourceControlDrag,
        actionRegion: getComputedStyle(action).getPropertyValue('app-region') };
      app.classList.toggle(id === 'wiki' ? 'hidden' : 'is-active', id === 'wiki');
      return snapshot;
    }));
    return { start, during, end, movingToggle, withoutThread, devServerLayouts, appHeaders };
  })()`);

  assert.equal(start.left, start.railRight);
  assert.equal(start.dragStripRegion, 'drag');
  assert.ok(start.dragStripRight <= start.controls.left);
  assert.equal(start.threadActionRegion, 'no-drag');
  for (const frame of [start, end]) {
    assert.equal(frame.threadActionsPosition, 'relative');
    assert.equal(frame.threadActionsRegion, 'no-drag');
    assert.ok(frame.bottomToggleClickable);
  }
  assert.equal(end.dragStripRegion, 'drag');
  for (const frame of [...during, movingToggle]) {
    assert.equal(frame.dragStripRegion, 'none');
    assert.equal(frame.menubarRegion, 'none');
    assert.ok(frame.bottomToggleClickable);
  }
  assert.ok(end.dragStripLeft >= end.sidebarToggle.right, 'collapsed navigation must stay outside the native drag region');
  assert.ok(end.threadTitleLeft - end.sidebarToggle.right <= 28, 'collapsed thread title should follow the visible navigation without a reserved label-width gap');
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
  for (const frame of devServerLayouts) {
    assert.ok(frame.previewTop >= frame.captionBottom, JSON.stringify(frame));
    assert.ok(frame.previewControlClickable && frame.closeClickable, JSON.stringify(frame));
    assert.equal(frame.addServerClickable, !frame.maximized, JSON.stringify(frame));
  }
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
    if (frame.id === 'sourceControl') {
      assert.equal(frame.sourceControlDrag.cachedIssuesHasLayout, false, 'inactive Issues must release its native drag region');
      assert.equal(frame.sourceControlDrag.headerRegion, 'none');
      assert.ok(frame.sourceControlDrag.width > 0);
      assert.equal(frame.sourceControlDrag.coveredControls, 0);
    }
    assert.equal(frame.topStrip, 'none');
    assert.equal(frame.headerColor, frame.stageColor);
    if (frame.sidebarOpen) assert.deepEqual(frame.sidebarToggle, start.sidebarToggle);
    else {
      assert.ok(frame.dragLeft >= frame.sidebarToggle.right, frame.id + ' drag region overlaps collapsed navigation');
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

  const titlebarEntry = await session.evaluate(`(() => {
    const app = document.getElementById('sourceControl');
    app.classList.add('is-active');
    const header = app.querySelector('header');
    const bounds = () => [header, ...header.querySelectorAll('button')].map(element => element.getBoundingClientRect().toJSON());
    const settled = bounds();
    app.classList.add('mn-os-app-enter');
    const animation = app.getAnimations().find(candidate => candidate.animationName === 'mn-os-app-in');
    animation.pause();
    animation.currentTime = animation.effect.getTiming().duration / 2;
    const entering = bounds();
    const clickable = [...header.querySelectorAll('button')].every(button => {
      const { left, top, width, height } = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(left + width / 2, top + height / 2));
    });
    app.classList.remove('mn-os-app-enter');
    const html = document.documentElement;
    header.getBoundingClientRect();
    html.classList.add('mn-graphite-sidebar-open', 'mn-graphite-sidebar-motion');
    const paddingMovesWithSidebar = header.getAnimations().some(candidate => candidate.transitionProperty === 'padding-left');
    html.classList.remove('mn-graphite-sidebar-motion');
    app.classList.remove('is-active');
    return { settled, entering, clickable, paddingMovesWithSidebar };
  })()`);
  assert.deepEqual(titlebarEntry.entering, titlebarEntry.settled, 'the native titlebar stays in place during app entry');
  assert.ok(titlebarEntry.clickable, 'Source Control actions are reachable during app entry');
  assert.ok(titlebarEntry.paddingMovesWithSidebar, 'Source Control adjusts its inset alongside the sidebar toggle');

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
      actionClear: action.right < caption.left,
      menubarRegion: getComputedStyle(document.getElementById('osMenubar')).getPropertyValue('app-region') };
  })()`);
  assert.deepEqual(detached, { top: start.top, captionWithinHeader: true, actionClear: true, menubarRegion: 'none' });

  await t.test('collapsed macOS navigation clears the traffic lights and the thread header clears navigation', async () => {
    await session.navigate(`http://127.0.0.1:${server.address().port}/`);
    await session.client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });

    for (const { width, zoom, wide, fullScreen } of [
      { width: 1440, zoom: 1, wide: true, fullScreen: false },
      { width: 1060, zoom: 0.8, wide: true, fullScreen: false },
      { width: 1060, zoom: 1.2, wide: false, fullScreen: false },
      { width: 1060, zoom: 1, wide: true, fullScreen: true },
    ]) {
      await session.client.send('Emulation.setDeviceMetricsOverride', {
        width, height: 900, mobile: false, deviceScaleFactor: 1,
      });
      const frame = await session.evaluate(`(() => {
        const html = document.documentElement;
        html.dataset.platform = 'darwin';
        html.dataset.windowFullScreen = '${fullScreen}';
        if (${wide}) html.dataset.macTitlebar = 'wide';
        else delete html.dataset.macTitlebar;
        html.style.setProperty('--mn-shell-zoom', '${zoom}');
        html.classList.remove('mn-graphite-sidebar-open');
        const navigation = document.querySelector('.mn-os-mb-left');
        const picker = navigation.querySelector('.mn-os-mb-workspace-slot button');
        const toggle = document.getElementById('sidebarToggle');
        const header = document.getElementById('graphiteThreadHeader');
        const bounds = element => element.getBoundingClientRect();
        document.querySelector('.mn-os').style.setProperty('--mn-titlebar-measured-navigation-width', bounds(navigation).width + 'px');
        const dragStrip = getComputedStyle(header, '::before');
        const clickable = element => {
          const { left, top, width, height } = bounds(element);
          return element.contains(document.elementFromPoint(left + width / 2, top + height / 2));
        };
        return {
          pickerLeft: bounds(picker).left,
          toggleRight: bounds(toggle).right,
          titleLeft: bounds(header.querySelector('h1')).left,
          dragLeft: bounds(header).left + parseFloat(dragStrip.left),
          navigationClickable: clickable(picker) && clickable(toggle),
          threadActionClickable: clickable(document.getElementById('threadAction')),
        };
      })()`);
      const detail = JSON.stringify({ width, zoom, wide, fullScreen, ...frame });
      if (fullScreen) assert.ok(frame.pickerLeft < 40, detail);
      else assert.ok(frame.pickerLeft >= (wide ? 77 : 71) / zoom + 16 - 1, detail);
      assert.ok(frame.titleLeft >= frame.toggleRight, detail);
      assert.ok(frame.titleLeft - frame.toggleRight <= 28, detail);
      assert.ok(frame.dragLeft >= frame.toggleRight, detail);
      assert.ok(frame.navigationClickable && frame.threadActionClickable, detail);
    }
  });
});
