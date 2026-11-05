import { isNavigationAllowed, originFromUrl } from '../cdp/allowlist.js';
import { loadBrowserConfig } from '../cdp/browser-config.js';
import { writeScreenshot } from '../cdp/paths.js';
import { connectTarget } from './cdp-client.js';
import { discoverBrowser } from './discover.js';
import {
  LIVENESS_PROBE_TIMEOUT_MS,
  MAX_CONSOLE_ENTRIES,
  buildLaunchArgs,
  capText,
  normalizeLaunchOptions,
} from './launch-options.js';
import { createProfileDir, removeProfileDir } from './profile.js';
import {
  checkBrowserHealth,
  killBrowserProcess,
  launchBrowserProcess,
  listTargets,
} from './process.js';
import { takeSnapshot } from './snapshot.js';

export class BrowserDriverError extends Error {
  /**
 * @param {string} message
 * @param {'gone' | 'allowlist' | 'timeout' | 'protocol' | 'closed' | 'invalid'} code
 */
  constructor(message, code) {
    super(message);
    this.name = 'BrowserDriverError';
    this.code = code;
  }
}

/**
 * @typedef {'user' | 'hard-timeout' | 'unresponsive' | 'external' | 'launch-failure'} SessionEndReason
 * @typedef {object} SessionStatus
 * @property {boolean} alive
 * @property {number} pid
 * @property {number} port
 * @property {string} profileDir
 * @property {string} executablePath
 * @property {string} browserVersion
 * @property {SessionEndReason | null} endedReason
 * @property {string | null} endedDetail
 * @property {string | null} currentUrl
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

export class BrowserPage {
  #assertAlive() {
    if (!this.alive) {
      throw new BrowserDriverError(
        `browser session is not usable: ${this.endedReason ?? 'ended'}` +
          (this.endedDetail ? ` (${this.endedDetail})` : ''),
        'gone',
      );
    }
  }

  /**
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ outcome: 'loaded' | 'timeout', url: string, title: string, killed?: boolean }>}
 */
  async navigate(url, opts = {}) {
    this.#assertAlive();
    const target = String(url ?? '').trim();
    if (!target) throw new BrowserDriverError('url is required', 'invalid');
    let origin;
    try {
      origin = originFromUrl(target);
    } catch {
      throw new BrowserDriverError(`invalid url: ${target}`, 'invalid');
    }
    if (!isNavigationAllowed(target, this.allowedOriginPatterns)) {
      throw new BrowserDriverError(
        `navigation blocked by allowlist: ${origin}. ` +
          'Add the origin under Settings → Browser (browser.allowedOriginPatterns) to allow it.',
        'allowlist',
      );
    }

    const timeoutMs = opts.timeoutMs ?? this.options.navigationTimeoutMs;
    const startedAt = Date.now();
    const remaining = () => Math.max(0, timeoutMs - (Date.now() - startedAt));

    let loaded = false;
    /** @type {(() => void) | null} */
    let resolveLoad = null;
    const loadPromise = new Promise((resolve) => {
      resolveLoad = () => {
        loaded = true;
        resolve(undefined);
      };
    });
    /** @type {(params: Record<string, unknown>) => void} */
    const onLoad = () => resolveLoad?.();
    this.client.on('Page.loadEventFired', onLoad);

    this.lastSnapshot = null;
    try {
      const ack = this.client.send('Page.navigate', { url: target }, { timeoutMs: timeoutMs + 1_000 });
      ack.catch(() => {});
      const acked = await Promise.race([
        ack.then(
          () => /** @type {const} */ ('ok'),
          (err) => (err?.code === 'closed' ? /** @type {const} */ ('closed') : /** @type {const} */ ('stalled')),
        ),
        delay(timeoutMs).then(() => /** @type {const} */ ('stalled')),
      ]);

      if (acked === 'closed') {
        throw new BrowserDriverError(`browser connection closed while navigating to ${target}`, 'gone');
      }
      if (acked === 'ok') {
        await Promise.race([loadPromise, delay(remaining())]);
      }
    } finally {
      this.client.off('Page.loadEventFired', onLoad);
    }

    if (!loaded) {
      try {
        await this.client.send('Page.stopLoading', {}, { timeoutMs: LIVENESS_PROBE_TIMEOUT_MS });
      } catch {
      }
      const responsive = await this.isResponsive();
      if (!responsive) {
        await this.kill('unresponsive', `browser stopped answering while loading ${target}`);
        return { outcome: 'timeout', url: target, title: '', killed: true };
      }
      this.currentUrl = target;
      const title = await this.#safeTitle();
      return { outcome: 'timeout', url: target, title };
    }

    this.currentUrl = target;
    return { outcome: 'loaded', url: target, title: await this.#safeTitle() };
  }

  /** @returns {Promise<string>} */
  async #safeTitle() {
    try {
      const value = await this.evaluate('document.title');
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  }

  /**
 * @param {string} expression
 * @param {{ timeoutMs?: number, awaitPromise?: boolean }} [opts]
 * @returns {Promise<unknown>}
 */
  async evaluate(expression, opts = {}) {
    this.#assertAlive();
    const result = await this.client.send(
      'Runtime.evaluate',
      {
        expression: String(expression),
        returnByValue: true,
        awaitPromise: opts.awaitPromise === true,
      },
      { timeoutMs: opts.timeoutMs ?? this.options.commandTimeoutMs },
    );
    const exception = /** @type {any} */ (result).exceptionDetails;
    if (exception) {
      const text = exception.exception?.description ?? exception.text ?? 'evaluation threw';
      throw new BrowserDriverError(`page evaluation failed: ${text}`, 'protocol');
    }
    return /** @type {any} */ (result).result?.value;
  }

  /**
 * @param {{ maxChars?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
  async text(opts = {}) {
    const value = await this.evaluate(
      'document.body ? document.body.innerText : ""',
      { timeoutMs: opts.timeoutMs },
    );
    return capText(typeof value === 'string' ? value : String(value ?? ''), opts.maxChars);
  }

  /**
 * @param {{ maxChars?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
  async html(opts = {}) {
    const value = await this.evaluate(
      'document.documentElement ? document.documentElement.outerHTML : ""',
      { timeoutMs: opts.timeoutMs },
    );
    return capText(typeof value === 'string' ? value : String(value ?? ''), opts.maxChars);
  }

  /**
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<import('./snapshot.js').Snapshot>}
 */
  async snapshot(opts = {}) {
    this.#assertAlive();
    await this.client.send('Accessibility.enable', {}, { timeoutMs: this.options.commandTimeoutMs });
    const snap = await takeSnapshot(this.client, {
      timeoutMs: opts.timeoutMs ?? this.options.commandTimeoutMs,
    });
    this.lastSnapshot = snap;
    return snap;
  }

  /**
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, id: string, filePath: string, sizeBytes: number } | { ok: false, error: string }>}
 */
  async screenshot(opts = {}) {
    if (!this.alive) return { ok: false, error: 'browser session is not usable' };
    try {
      const result = await this.client.send(
        'Page.captureScreenshot',
        { format: 'png' },
        { timeoutMs: opts.timeoutMs ?? this.options.commandTimeoutMs },
      );
      const data = /** @type {any} */ (result).data;
      if (typeof data !== 'string' || !data) {
        return { ok: false, error: 'browser returned no screenshot data' };
      }
      const written = await writeScreenshot(Buffer.from(data, 'base64'));
      return { ok: true, ...written };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

}

export class BrowserSession extends BrowserPage {
  /**
 * @param {object} input
 * @param {import('./process.js').BrowserProcessHandle} input.handle
 * @param {import('./cdp-client.js').CdpClient} input.client
 * @param {string} input.targetId
 * @param {import('./launch-options.js').NormalizedLaunchOptions} input.options
 * @param {string[]} input.allowedOriginPatterns
 * @param {string} input.browserVersion
 * @param {boolean} input.ownsProfileDir
 */
  constructor(input) {
    super();
    this.handle = input.handle;
    this.client = input.client;
    this.targetId = input.targetId;
    this.options = input.options;
    this.allowedOriginPatterns = input.allowedOriginPatterns;
    this.browserVersion = input.browserVersion;
    this.ownsProfileDir = input.ownsProfileDir;

    this.alive = true;
    /** @type {SessionEndReason | null} */
    this.endedReason = null;
    /** @type {string | null} */
    this.endedDetail = null;
    /** @type {string | null} */
    this.currentUrl = null;
    /** @type {import('./snapshot.js').Snapshot | null} */
    this.lastSnapshot = null;
    /** @type {Array<{ level: string, text: string, at: number }>} */
    this.console = [];
    /** @type {Promise<void> | null} */
    this.closing = null;

    this.handle.child.on('exit', () => {
      if (this.alive) this.#markDead('external', 'the browser process exited unexpectedly');
    });
    this.hardTimer = setTimeout(() => {
      void this.kill('hard-timeout', `session exceeded hardTimeoutMs=${this.options.hardTimeoutMs}`);
    }, this.options.hardTimeoutMs);
    if (typeof this.hardTimer.unref === 'function') this.hardTimer.unref();

    if (this.handle.child.exitCode !== null || this.handle.child.signalCode !== null) {
      this.#markDead('external', 'the browser process exited unexpectedly');
    }
  }

  /**
 * @param {SessionEndReason} reason
 * @param {string} detail
 */
  #markDead(reason, detail) {
    if (!this.alive) return;
    this.alive = false;
    this.endedReason = reason;
    this.endedDetail = detail;
    clearTimeout(this.hardTimer);
    try {
      this.client.close(`browser session ended: ${reason}`);
    } catch {
    }
  }

  /** @returns {SessionStatus} */
  status() {
    return {
      alive: this.alive,
      pid: this.handle.pid,
      port: this.handle.port,
      profileDir: this.handle.profileDir,
      executablePath: this.handle.executablePath,
      browserVersion: this.browserVersion,
      endedReason: this.endedReason,
      endedDetail: this.endedDetail,
      currentUrl: this.currentUrl,
    };
  }

  /**
 * @returns {Promise<boolean>}
 */
  async isResponsive() {
    if (!this.alive) return false;
    const health = await checkBrowserHealth(this.handle.port, LIVENESS_PROBE_TIMEOUT_MS);
    return health.ok;
  }

  /**
 * @param {string} level
 * @param {string} text
 */
  recordConsoleEntry(level, text) {
    this.console.push({ level, text: capText(text, 2_000), at: Date.now() });
    if (this.console.length > MAX_CONSOLE_ENTRIES) this.console.shift();
  }

  consoleMessages() {
    return this.console.map((entry) => ({ ...entry }));
  }

  /**
 * @param {SessionEndReason} [reason]
 * @param {string} [detail]
 * @returns {Promise<SessionStatus>}
 */
  async kill(reason = 'user', detail = '') {
    if (this.closing) {
      await this.closing;
      return this.status();
    }
    this.closing = (async () => {
      this.#markDead(reason, detail || `session ended (${reason})`);
      await killBrowserProcess(this.handle.child);
      if (this.ownsProfileDir) await removeProfileDir(this.handle.profileDir);
    })();
    await this.closing;
    return this.status();
  }

  /**
 * @returns {Promise<SessionStatus>}
 */
  async close() {
    return this.kill('user', 'closed by caller');
  }
}

/**
 * @typedef {object} LaunchSuccess
 * @property {true} ok
 * @property {BrowserSession} session
 * @property {import('./discover.js').BrowserCapabilityAvailable} capability
 * @typedef {object} LaunchFailure
 * @property {false} ok
 * @property {'disabled-in-settings' | 'no-chromium-browser' | 'env-path-missing' | 'launch-failed'} reason
 * @property {string} detail
 * @typedef {LaunchSuccess | LaunchFailure} LaunchResult
 */

/**
 * @param {import('./launch-options.js').LaunchOptions & { label?: string }} [opts]
 * @returns {Promise<LaunchResult>}
 */
export async function launchBrowser(opts = {}) {
  const options = normalizeLaunchOptions(opts);

  /** @type {string[]} */
  let allowedOriginPatterns;
  let enabled = true;
  try {
    const cfg = await loadBrowserConfig();
    enabled = cfg.enabled !== false;
    allowedOriginPatterns = opts.allowedOriginPatterns ?? cfg.allowedOriginPatterns;
  } catch {
    allowedOriginPatterns = opts.allowedOriginPatterns ?? [];
  }
  if (!enabled) {
    return {
      ok: false,
      reason: 'disabled-in-settings',
      detail: 'browser automation is disabled in settings (browser.enabled = false)',
    };
  }

  const capability = await discoverBrowser({
    executablePath: opts.executablePath,
    env: opts.env,
  });
  if (!capability.available) {
    return { ok: false, reason: capability.reason, detail: capability.detail };
  }

  const ownsProfileDir = !opts.profileDir;
  const profileDir = opts.profileDir ?? (await createProfileDir(opts.label));

  /** @type {import('./process.js').BrowserProcessHandle} */
  let handle;
  try {
    handle = await launchBrowserProcess({
      executablePath: capability.executablePath,
      profileDir,
      args: buildLaunchArgs({ profileDir, options }),
      launchTimeoutMs: options.launchTimeoutMs,
    });
  } catch (err) {
    if (ownsProfileDir) await removeProfileDir(profileDir);
    return {
      ok: false,
      reason: 'launch-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const health = await checkBrowserHealth(handle.port);
    const targets = await listTargets(handle.port);
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('browser started but exposed no page target');

    const client = await connectTarget(page.webSocketDebuggerUrl, {
      commandTimeoutMs: options.commandTimeoutMs,
      connectTimeoutMs: options.launchTimeoutMs,
    });

    const session = new BrowserSession({
      handle,
      client,
      targetId: page.id,
      options,
      allowedOriginPatterns,
      browserVersion: health.ok ? health.version : 'unknown',
      ownsProfileDir,
    });

    client.on('Runtime.consoleAPICalled', (params) => {
      const args = /** @type {any[]} */ (params.args ?? []);
      const text = args
        .map((a) => (a?.value !== undefined ? String(a.value) : String(a?.description ?? '')))
        .join(' ');
      session.recordConsoleEntry(String(params.type ?? 'log'), text);
    });
    client.on('Runtime.exceptionThrown', (params) => {
      const details = /** @type {any} */ (params.exceptionDetails ?? {});
      session.recordConsoleEntry(
        'exception',
        String(details.exception?.description ?? details.text ?? 'uncaught exception'),
      );
    });
    client.on('Log.entryAdded', (params) => {
      const entry = /** @type {any} */ (params.entry ?? {});
      session.recordConsoleEntry(String(entry.level ?? 'log'), String(entry.text ?? ''));
    });

    await client.send('Page.enable', {}, { timeoutMs: options.commandTimeoutMs });
    await client.send('Runtime.enable', {}, { timeoutMs: options.commandTimeoutMs });
    try {
      await client.send('Log.enable', {}, { timeoutMs: options.commandTimeoutMs });
    } catch {
    }

    return { ok: true, session, capability };
  } catch (err) {
    await killBrowserProcess(handle.child);
    if (ownsProfileDir) await removeProfileDir(profileDir);
    return {
      ok: false,
      reason: 'launch-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
