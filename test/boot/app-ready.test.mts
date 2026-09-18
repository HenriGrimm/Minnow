import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Window } from 'happy-dom';
import {
  APP_LOADER_REMOVE_DELAY_MS,
  APP_CSS_READY_PROPERTY,
  isAppShellStyled,
  isChromeReady,
  markAppReady,
  markChromeReady,
  resetAppReadyForTests,
  scheduleMarkAppReady,
  whenAppShellStyled,
  whenAppStylesReady,
} from '../../src/boot/app-ready.ts';

describe('whenAppStylesReady', () => {
  let win: Window;

  afterEach(() => {
    resetAppReadyForTests();
    win?.close();
  });

  it('resolves immediately when there are no stylesheet links', async () => {
    win = new Window();
    const g = globalThis as typeof globalThis & { document: Document; window: Window };
    g.document = win.document;
    g.window = win as unknown as Window & typeof globalThis.window;

    await assert.doesNotReject(() => whenAppStylesReady());
  });

  it('resolves when a stylesheet link is already loaded', async () => {
    win = new Window();
    const g = globalThis as typeof globalThis & { document: Document; window: Window };
    g.document = win.document;
    g.window = win as unknown as Window & typeof globalThis.window;

    const link = win.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://example.test/app.css';
    Object.defineProperty(link, 'sheet', { value: {} });
    win.document.head.appendChild(link);

    await whenAppStylesReady();
  });

  it('ignores third-party stylesheet links', async () => {
    win = new Window();
    const g = globalThis as typeof globalThis & { document: Document; window: Window };
    g.document = win.document;
    g.window = win as unknown as Window & typeof globalThis.window;

    const external = win.document.createElement('link');
    external.rel = 'stylesheet';
    external.href = 'https://fonts.googleapis.com/css2?family=Test';
    Object.defineProperty(external, 'sheet', { configurable: true, get: () => null });
    win.document.head.appendChild(external);

    await whenAppStylesReady();
  });

  it('waits for a bundled stylesheet link load event', async () => {
    win = new Window();
    const g = globalThis as typeof globalThis & { document: Document; window: Window };
    g.document = win.document;
    g.window = win as unknown as Window & typeof globalThis.window;

    const link = win.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://example.test/assets/pending.css';
    Object.defineProperty(link, 'sheet', { configurable: true, get: () => null });
    win.document.head.appendChild(link);

    const pending = whenAppStylesReady();
    link.dispatchEvent(new win.Event('load'));
    await pending;
  });

  it('resolves when a bundled link is already loaded before listeners attach', async () => {
    win = new Window();
    const g = globalThis as typeof globalThis & { document: Document; window: Window };
    g.document = win.document;
    g.window = win as unknown as Window & typeof globalThis.window;

    const link = win.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://example.test/assets/already.css';
    Object.defineProperty(link, 'sheet', { configurable: true, get: () => ({}) });
    win.document.head.appendChild(link);

    await assert.doesNotReject(() => whenAppStylesReady());
  });
});

type BootGlobals = typeof globalThis & {
  document: Document;
  window: Window;
  getComputedStyle: typeof getComputedStyle;
  requestAnimationFrame: typeof requestAnimationFrame;
};

/** Install a happy-dom window as the globals `app-ready.ts` reads. */
function installWindow(win: Window): void {
  const g = globalThis as BootGlobals;
  g.document = win.document;
  g.window = win as unknown as Window & typeof globalThis.window;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  g.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    win.setTimeout(() => cb(win.performance.now()), 8)) as typeof requestAnimationFrame;
}

/** Mirror the `:root` sentinel that `styles/tokens.css` ships. */
function applyAppCss(win: Window): void {
  const style = win.document.createElement('style');
  style.textContent = `:root { ${APP_CSS_READY_PROPERTY}: 1; }`;
  win.document.head.appendChild(style);
}

describe('isAppShellStyled', () => {
  let win: Window;

  afterEach(() => {
    resetAppReadyForTests();
    win?.close();
  });

  it('returns true once the app CSS sentinel resolves', () => {
    win = new Window();
    installWindow(win);
    applyAppCss(win);

    assert.equal(isAppShellStyled(), true);
  });

  it('returns false before app CSS is applied', () => {
    win = new Window();
    installWindow(win);

    assert.equal(isAppShellStyled(), false);
  });

  // Regression: the old probe read `.topbar` geometry, but the OS desktop shell —
  // the default route — hides the topbar, so it never resolved and every launch
  // paid the full outer safety timeout before the loader was dismissed.
  it('ignores shell chrome that the active route hides', () => {
    win = new Window();
    installWindow(win);
    applyAppCss(win);

    const topbar = win.document.createElement('header');
    topbar.className = 'topbar hidden';
    win.document.body.appendChild(topbar);
    const hide = win.document.createElement('style');
    hide.textContent = '.topbar.hidden { display: none; }';
    win.document.head.appendChild(hide);

    assert.equal(isAppShellStyled(), true);
  });
});

describe('whenAppShellStyled', () => {
  let win: Window;

  afterEach(() => {
    resetAppReadyForTests();
    win?.close();
  });

  it('resolves immediately when app CSS is already applied', async () => {
    win = new Window();
    installWindow(win);
    applyAppCss(win);

    await whenAppShellStyled(50);
  });

  it('resolves once app CSS lands while polling', async () => {
    win = new Window();
    installWindow(win);

    const pending = whenAppShellStyled(2_000);
    win.setTimeout(() => applyAppCss(win), 20);
    await pending;

    assert.equal(isAppShellStyled(), true);
  });

  // The probe must never be able to hold the loader for the full outer timeout.
  it('gives up at its own deadline when the probe never succeeds', async () => {
    win = new Window();
    installWindow(win);

    const startedAt = Date.now();
    await whenAppShellStyled(60);
    const elapsed = Date.now() - startedAt;

    assert.equal(isAppShellStyled(), false);
    assert.ok(elapsed < 1_000, `expected a bounded wait, took ${elapsed}ms`);
  });
});

describe('dual-gate chrome ready', () => {
  let win: Window;

  afterEach(() => {
    resetAppReadyForTests();
    win?.close();
  });

  it('markChromeReady is idempotent and flips isChromeReady', () => {
    win = new Window();
    installWindow(win);
    assert.equal(isChromeReady(), false);
    markChromeReady();
    markChromeReady();
    assert.equal(isChromeReady(), true);
  });

  it('reveals only after both CSS and chrome gates', async () => {
    win = new Window();
    installWindow(win);
    win.document.body.innerHTML = '<div id="app-loader"></div>';

    scheduleMarkAppReady();
    markChromeReady();
    await new Promise<void>((resolve) => win.setTimeout(resolve, 40));
    assert.equal(win.document.documentElement.classList.contains('app-ready'), false);

    applyAppCss(win);
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 2_000;
      const tick = () => {
        if (win.document.documentElement.classList.contains('app-ready') || Date.now() >= deadline) {
          resolve();
          return;
        }
        win.setTimeout(tick, 8);
      };
      tick();
    });
    assert.equal(win.document.documentElement.classList.contains('app-ready'), true);
  });

  it('does not treat the stylesheet deadline as chrome-ready', async () => {
    win = new Window();
    installWindow(win);
    win.document.body.innerHTML = '<div id="app-loader"></div>';

    scheduleMarkAppReady({ styleTimeoutMs: 20, chromeTimeoutMs: 100 });
    applyAppCss(win);

    await new Promise<void>((resolve) => win.setTimeout(resolve, 55));
    assert.equal(
      win.document.documentElement.classList.contains('app-ready'),
      false,
      'slow chrome must remain behind the loader after the CSS deadline',
    );

    await new Promise<void>((resolve) => win.setTimeout(resolve, 80));
    assert.equal(
      win.document.documentElement.classList.contains('app-ready'),
      true,
      'the longer chrome escape hatch must still prevent a permanent loader',
    );
  });

  it('uses the stylesheet deadline when chrome is ready but CSS never signals', async () => {
    win = new Window();
    installWindow(win);
    win.document.body.innerHTML = '<div id="app-loader"></div>';

    scheduleMarkAppReady({ styleTimeoutMs: 20, chromeTimeoutMs: 100 });
    markChromeReady();

    await new Promise<void>((resolve) => win.setTimeout(resolve, 60));
    assert.equal(win.document.documentElement.classList.contains('app-ready'), true);
  });
});

describe('boot loader teardown', () => {
  let win: Window;

  afterEach(() => {
    resetAppReadyForTests();
    win?.close();
  });

  it('removes the loader after the fade so its spinner stops animating', async () => {
    win = new Window();
    const g = globalThis as typeof globalThis & { document: Document; window: Window };
    g.document = win.document as unknown as Document;
    g.window = win;
    win.document.body.innerHTML =
      '<div id="app-loader"><div class="app-loader__spinner"></div>' +
      '<p id="appLoaderStatus">Loading…</p></div>';

    markAppReady();

    // Still present during the opacity transition, but flagged done for a11y.
    const during = win.document.getElementById('app-loader');
    assert.ok(during);
    assert.equal(during.getAttribute('aria-hidden'), 'true');
    assert.equal(win.document.documentElement.classList.contains('app-ready'), true);

    await new Promise((resolve) => setTimeout(resolve, APP_LOADER_REMOVE_DELAY_MS + 60));

    // A full-viewport fixed layer at opacity 0 still composites — it must be gone.
    assert.equal(win.document.getElementById('app-loader'), null);
  });
});
