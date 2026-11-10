import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';

test('populated model pickers keep both model lists reachable at every anchor', { timeout: 30_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-model-picker-'));
  const [tokens, modelSelect, composer, source] = await Promise.all([
    ...['tokens', 'model-select', 'composer-model-trigger'].map(name =>
      readFile(new URL(`../../src/styles/${name}.css`, import.meta.url), 'utf8')),
    readFile(new URL('../../src/ui/model-picker-position.ts', import.meta.url), 'utf8'),
  ]);
  const script = transformSync(source, { loader: 'ts', format: 'esm' }).code;
  const models = count => Array.from({ length: count }, (_, index) =>
    `<li class="model-select-row"><button class="model-select-option">Model ${index + 1}</button><button class="model-select-favorite" aria-label="Favorite">☆</button></li>`).join('');
  const providers = Array.from({ length: 8 }, (_, index) => `<button class="model-browser-provider">Provider ${index + 1}</button>`).join('');
  const server = http.createServer((req, res) => {
    if (req.url === '/position.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(script);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><style>${tokens}\n${modelSelect}\n${composer}
      * { box-sizing: border-box; } #anchor { position: fixed; left: 55%; width: 100px; height: 30px; }
    </style>
    <button id="anchor">Select a model</button>
    <div class="composer-model-menu composer-model-menu--code">
      <div class="model-select-host-filter composer-model-menu__filter">
        <label class="model-host-filter-search-wrap"><input class="model-host-filter-search" placeholder="Search models"></label>
        <div class="model-host-filter-controls"><button class="model-host-filter-segment">All</button></div>
      </div>
      <ul class="model-select-menu composer-model-menu__list model-provider-browser">
        <li class="model-picker-favorites"><div class="model-browser-heading">Favorites</div>
          <ul class="model-browser-models model-browser-favorite-list">${models(5)}</ul></li>
        <li class="model-browser-providers"><div class="model-browser-heading">Providers</div>
          <div class="model-browser-columns"><div class="model-browser-rail">${providers}</div>
          <div class="model-browser-pane"><div class="model-browser-pane-heading"><button class="model-browser-back" aria-label="Back to providers">‹</button>Provider models</div>
            <ul class="model-browser-models">${models(24)}</ul></div></div></li>
      </ul>
      <div class="composer-model-reasoning"><div class="composer-model-reasoning__heading">Reasoning</div>
        <div class="composer-model-reasoning__choices"><button class="composer-model-reasoning__choice">Default</button><button class="composer-model-reasoning__choice">High</button></div>
      </div>
      <div class="model-menu-actions"><button>Open settings</button></div>
    </div>
    <script type="module">
      import { positionAnchoredModelPicker } from '/position.js';
      const panel = document.querySelector('.composer-model-menu');
      const anchor = document.getElementById('anchor');
      window.measurePicker = (top, preferred, phone, providerOpen) => {
        anchor.style.top = top + 'px';
        document.documentElement.classList.toggle('mn-phone', phone);
        document.querySelector('.model-browser-columns').classList.toggle('is-provider-open', providerOpen);
        delete panel.dataset.placement;
        positionAnchoredModelPicker(panel, anchor, preferred, 8);
        const measure = selector => {
          const el = document.querySelector(selector);
          return { ...el.getBoundingClientRect().toJSON(), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
        };
        return {
          placement: panel.dataset.placement,
          constrained: panel.hasAttribute('data-model-menu-constrained'),
          panel: measure('.composer-model-menu'),
          favorites: measure('.model-browser-favorite-list'),
          providers: measure('.model-browser-rail'),
          models: measure('.model-browser-pane .model-browser-models'),
          reasoning: measure('.composer-model-reasoning'),
        };
      };
    </script>`);
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
    allowedOriginPatterns: ['http://127.0.0.1:*'], viewport: { width: 1440, height: 900 }, hardTimeoutMs: 25_000,
  });
  assert.ok(result.ok, result.detail);
  session = result.session;
  await session.navigate(`http://127.0.0.1:${server.address().port}/`);
  for (const [width, height, anchorTop, preferred, expected] of [
    [1440, 900, 48, 'above', 'below'],
    [1440, 900, 820, 'below', 'above'],
    [390, 740, 630, 'above', 'above'],
    [360, 640, 50, 'below', 'below'],
    [390, 340, 158, 'above', 'above'],
  ]) {
    await session.client.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 1 });
    await session.client.send('Emulation.setTouchEmulationEnabled', { enabled: width < 700 });
    const phone = width < 700;
    const state = await session.evaluate(`window.measurePicker(${anchorTop}, '${preferred}', ${phone}, false)`);
    assert.equal(state.placement, expected, JSON.stringify(state));
    assert.ok(state.panel.top >= 8 && state.panel.bottom <= height - 8 && state.panel.left >= 8 && state.panel.right <= width - 8, JSON.stringify(state));
    assert.ok(state.favorites.clientHeight >= 28 && state.providers.clientHeight >= 44, JSON.stringify(state));
    if (phone) {
      assert.equal(state.models.clientHeight, 0, 'provider browsing has no adjacent empty pane on phone');
      const selected = await session.evaluate(`window.measurePicker(${anchorTop}, '${preferred}', true, true)`);
      assert.equal(selected.providers.clientHeight, 0, 'selected models replace the provider list on phone');
      assert.equal(selected.models.width, state.providers.width);
      assert.ok(selected.models.clientHeight >= 36 && selected.models.scrollHeight > selected.models.clientHeight, JSON.stringify(selected));
    } else {
      assert.ok(state.models.scrollHeight > state.models.clientHeight, 'catalog retains its own scrolling');
      assert.equal(state.favorites.clientHeight, state.favorites.scrollHeight, 'all five favorites fit on desktop');
      assert.ok(state.providers.clientHeight >= 126, JSON.stringify(state));
      assert.ok(state.reasoning.left > state.models.left, 'reasoning sits beside the model list');
    }
    if (height === 340) {
      assert.equal(state.constrained, true);
      assert.ok(state.panel.scrollHeight > state.panel.clientHeight, 'the whole panel remains reachable in a short viewport');
    }
  }
});
