import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BrowserDriverError, connectTarget, launchBrowser } from '../browser-driver/index.js';
import { isNavigationAllowed } from '../cdp/allowlist.js';

export const DEFAULT_AGENT_BROWSER_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
export const DEFAULT_AGENT_BROWSER_HARD_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
export const DEFAULT_AGENT_BROWSER_MAX_TABS = 8;

export class AgentBrowserError extends Error {
  /** @param {string} message @param {'invalid'|'not-found'|'not-owner'|'stale-lease'|'busy'|'closed'|'launch-failed'|'unsafe-transfer'} code */
  constructor(message, code) {
    super(message);
    this.name = 'AgentBrowserError';
    this.code = code;
  }
}

/** @param {unknown} value @param {string} field */
function requiredId(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new AgentBrowserError(`${field} is required`, 'invalid');
  return text;
}

/** @param {unknown} value */
function normalizeOwner(value) {
  if (!value || typeof value !== 'object') {
    throw new AgentBrowserError('trusted owner identity is required', 'invalid');
  }
  const owner = /** @type {Record<string, unknown>} */ (value);
  return Object.freeze({
    chatId: requiredId(owner.chatId, 'owner.chatId'),
    runId: requiredId(owner.runId, 'owner.runId'),
    agentId: requiredId(owner.agentId, 'owner.agentId'),
  });
}

/** @param {ReturnType<typeof normalizeOwner> | null} a @param {ReturnType<typeof normalizeOwner>} b */
function sameOwner(a, b) {
  return Boolean(
    a && a.chatId === b.chatId && a.runId === b.runId && a.agentId === b.agentId,
  );
}

/** @param {unknown} input */
function normalizeViewport(input) {
  const value = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
  const width = Math.floor(Number(value.width ?? DEFAULT_AGENT_BROWSER_VIEWPORT.width));
  const height = Math.floor(Number(value.height ?? DEFAULT_AGENT_BROWSER_VIEWPORT.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 200 || width > 4000 || height > 4000) {
    throw new AgentBrowserError('viewport width and height must be between 200 and 4000', 'invalid');
  }
  return Object.freeze({ width, height });
}

/** @param {any} tab */
function publicTab(tab) {
  return {
    tabId: tab.tabId,
    status: tab.status,
    title: tab.title,
    url: tab.url,
    owner: tab.owner ? { ...tab.owner } : null,
    viewport: { ...tab.viewport },
    controlMode: tab.controlMode,
    activity: tab.active && tab.active.action !== 'capture-frame'
      ? (tab.controlMode === 'watch' ? 'agent' : tab.controlMode)
      : 'idle',
    busy: Boolean(tab.active),
    currentAction: tab.active?.action ?? null,
    revision: tab.revision,
    frameRevision: tab.frameRevision,
    documentRevision: tab.documentRevision,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
  };
}

/** @param {string} url @param {string[]} patterns */
function isAllowedPageUrl(url, patterns) {
  return url === 'about:blank' || isNavigationAllowed(url, patterns);
}

/** @param {Buffer} png */
function pngDimensions(png) {
  if (png.length < 24 || png.subarray(1, 4).toString('ascii') !== 'PNG') {
    throw new AgentBrowserError('browser returned an invalid PNG frame', 'invalid');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** @param {unknown} value @param {number} max */
function finiteNumber(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > max) {
    throw new AgentBrowserError('input contains an invalid number', 'invalid');
  }
  return number;
}

/** @param {unknown} error */
function isUncertainProtocolFailure(error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  return code === 'timeout' || code === 'closed' || /\b(?:timeout|timed out|connection closed)\b/i.test(message);
}

/** @param {number} browserPid */
function startParentWatchdog(browserPid) {
  if (!Number.isInteger(browserPid) || browserPid <= 0) return null;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./watchdog.js', import.meta.url)), String(process.pid), String(browserPid)],
    {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
  child.on('error', () => {});
  child.unref();
  child.channel?.unref?.();
  return child;
}

/** @param {any} session @param {number} uid @param {number | undefined} timeoutMs */
async function resolveNode(session, uid, timeoutMs) {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new AgentBrowserError('uid must be a positive integer', 'invalid');
  }
  const snapshot = session.lastSnapshot;
  if (!snapshot) throw new AgentBrowserError('take a fresh snapshot before using a uid', 'invalid');
  const node = snapshot.byUid.get(uid);
  if (!node?.backendNodeId) throw new AgentBrowserError(`uid ${uid} is not actionable`, 'invalid');
  await session.client.send('DOM.enable', {}, { timeoutMs });
  const resolved = await session.client.send(
    'DOM.resolveNode',
    { backendNodeId: node.backendNodeId },
    { timeoutMs },
  );
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new AgentBrowserError(`uid ${uid} could not be resolved`, 'invalid');
  return { node, objectId };
}

/** @param {any} session @param {string} objectId @param {string} declaration @param {number | undefined} timeoutMs */
async function callOn(session, objectId, declaration, timeoutMs) {
  const result = await session.client.send(
    'Runtime.callFunctionOn',
    { objectId, functionDeclaration: declaration, returnByValue: true, awaitPromise: false },
    { timeoutMs },
  );
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'page operation failed';
    throw new AgentBrowserError(String(detail).split('\n')[0], 'invalid');
  }
  return result.result?.value;
}

/** @param {any} session @param {string} objectId */
async function releaseObject(session, objectId) {
  try {
    await session.client.send('Runtime.releaseObject', { objectId });
  } catch {
  }
}

export class AgentBrowserService extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {typeof launchBrowser} [opts.launcher]
   * @param {import('../browser-driver/index.js').LaunchOptions} [opts.launchOptions]
   * @param {{width:number,height:number}} [opts.viewport]
   * @param {number} [opts.maxTabs]
   * @param {typeof connectTarget} [opts.connector]
   */
  constructor(opts = {}) {
    super();
    this.launcher = opts.launcher ?? launchBrowser;
    this.connector = opts.connector ?? connectTarget;
    this.launchOptions = { ...opts.launchOptions };
    delete this.launchOptions.profileDir;
    this.defaultViewport = normalizeViewport(opts.viewport);
    const requestedMaxTabs = Number(opts.maxTabs ?? DEFAULT_AGENT_BROWSER_MAX_TABS);
    this.maxTabs = Number.isFinite(requestedMaxTabs)
      ? Math.max(1, Math.floor(requestedMaxTabs))
      : DEFAULT_AGENT_BROWSER_MAX_TABS;
    /** @type {Map<string, any>} */
    this.tabs = new Map();
    /** @type {any[]} */
    this.guideEvents = [];
    this.closed = false;
  }

  /** @param {ReturnType<typeof normalizeOwner>} owner @param {object} [opts] */
  async reserveTab(owner, opts = {}) {
    if (this.closed) throw new AgentBrowserError('agent browser service is closed', 'closed');
    if (this.tabs.size >= this.maxTabs) {
      throw new AgentBrowserError(`agent browser capacity reached (${this.maxTabs} tabs)`, 'busy');
    }
    const trustedOwner = normalizeOwner(owner);
    const viewport = normalizeViewport(opts.viewport ?? this.defaultViewport);
    const now = Date.now();
    const tabId = randomUUID();
    const lease = randomUUID();
    const tab = {
      tabId,
      lease,
      revision: 1,
      status: 'launching',
      owner: trustedOwner,
      viewport,
      controlMode: 'watch',
      title: '',
      url: 'about:blank',
      createdAt: now,
      updatedAt: now,
      session: null,
      launchPromise: null,
      browserClient: null,
      watchdog: null,
      policyViolation: null,
      policyTasks: new Set(),
      tail: Promise.resolve(),
      active: null,
      frameRevision: 0,
      documentRevision: 0,
      guideSelections: new Map(),
    };
    this.tabs.set(tabId, tab);
    this.#changed(tab);

    const tabLaunchOptions = { ...opts.launchOptions };
    delete tabLaunchOptions.profileDir;
    tab.launchPromise = (async () => {
      const launched = await this.launcher({
        label: `agent-${trustedOwner.agentId}-${tabId.slice(0, 8)}`,
        hardTimeoutMs: DEFAULT_AGENT_BROWSER_HARD_TIMEOUT_MS,
        ...this.launchOptions,
        ...tabLaunchOptions,
        viewport,
        headless: true,
      });
      if (!launched.ok) {
        throw new AgentBrowserError(`${launched.reason}: ${launched.detail}`, 'launch-failed');
      }
      tab.session = launched.session;
      tab.watchdog = startParentWatchdog(Number(launched.session.handle?.pid));
      if (this.tabs.get(tabId) !== tab || tab.status === 'closing') {
        await launched.session.close();
        throw new AgentBrowserError('tab was closed while its browser was launching', 'closed');
      }
      await this.#initializeTab(tab);
      if (this.tabs.get(tabId) !== tab || tab.status === 'closing') {
        tab.browserClient?.close('tab closed during initialization');
        await launched.session.close();
        throw new AgentBrowserError('tab was closed while its browser was initializing', 'closed');
      }
      return launched;
    })();
    try {
      await tab.launchPromise;
    } catch (error) {
      tab.browserClient?.close('agent browser launch failed');
      if (tab.session?.alive) await tab.session.close();
      if (this.tabs.get(tabId) === tab && tab.status !== 'closing') this.tabs.delete(tabId);
      this.emit('tabs-changed', this.listTabs());
      if (error instanceof AgentBrowserError) throw error;
      throw new AgentBrowserError(error instanceof Error ? error.message : String(error), 'launch-failed');
    }
    tab.status = 'ready';
    tab.updatedAt = Date.now();
    this.#changed(tab);

    if (opts.url) {
      await this.navigate({ owner: trustedOwner, tabId, lease, url: opts.url });
    }
    return { tab: publicTab(tab), lease };
  }

  /** @param {any} tab */
  async #initializeTab(tab) {
    const timeoutMs = this.launchOptions.commandTimeoutMs;
    await tab.session.client.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: tab.viewport.width,
        height: tab.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: tab.viewport.width,
        screenHeight: tab.viewport.height,
      },
      { timeoutMs },
    );
    tab.session.client.on('Fetch.requestPaused', (params) => {
      const requestId = String(params.requestId ?? '');
      const url = String(params.request?.url ?? '');
      const isDocument = params.resourceType === 'Document';
      const allowed = !isDocument || isAllowedPageUrl(url, tab.session.allowedOriginPatterns);
      if (!allowed) tab.policyViolation = url;
      const task = tab.session.client.send(
        allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' },
        { timeoutMs },
      ).catch(() => {});
      tab.policyTasks.add(task);
      void task.finally(() => tab.policyTasks.delete(task));
    });
    await tab.session.client.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] },
      { timeoutMs },
    );

    tab.browserClient = await this.connector(tab.session.handle.browserWsUrl, {
      commandTimeoutMs: timeoutMs,
      connectTimeoutMs: this.launchOptions.launchTimeoutMs,
    });
    tab.browserClient.on('Target.targetCreated', (params) => {
      const info = params.targetInfo ?? {};
      if (info.type !== 'page' || info.targetId === tab.session.targetId) return;
      void tab.browserClient.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    });
    await tab.browserClient.send('Target.setDiscoverTargets', { discover: true }, { timeoutMs });
  }

  listTabs() {
    return [...this.tabs.values()].map(publicTab);
  }

  /** @param {unknown} owner */
  listOwnedTabs(owner) {
    const trustedOwner = normalizeOwner(owner);
    return [...this.tabs.values()].filter((tab) => sameOwner(tab.owner, trustedOwner)).map(publicTab);
  }

  /** @param {{owner:unknown,tabId:string,lease:string}|unknown} input @param {string} [tabId] */
  inspectOwnedTab(input, tabId) {
    if (tabId !== undefined) {
      const owner = normalizeOwner(input);
      const tab = this.#tab(tabId);
      if (!sameOwner(tab.owner, owner)) throw new AgentBrowserError('tab is reserved by another owner', 'not-owner');
      return publicTab(tab);
    }
    return publicTab(this.#reservation(input).tab);
  }

  /** Refresh trusted browser policy after a settings or approval change. */
  updateTabPolicy(tabId, allowedOriginPatterns) {
    const tab = this.#tab(tabId);
    if (!Array.isArray(allowedOriginPatterns)) {
      throw new AgentBrowserError('allowed origin patterns must be an array', 'invalid');
    }
    tab.session.allowedOriginPatterns = allowedOriginPatterns
      .filter((pattern) => typeof pattern === 'string' && pattern.trim())
      .map((pattern) => pattern.trim());
    return publicTab(tab);
  }

  /** @param {{owner:unknown,tabId:string,lease:string,url:string,timeoutMs?:number}} input */
  navigate(input) {
    return this.#run(input, 'navigate', async (tab) => {
      tab.policyViolation = null;
      const result = await tab.session.navigate(input.url, { timeoutMs: input.timeoutMs });
      await Promise.allSettled([...tab.policyTasks]);
      if (tab.policyViolation) {
        throw new BrowserDriverError(`navigation blocked by allowlist: ${tab.policyViolation}`, 'allowlist');
      }
      tab.url = await tab.session.evaluate('location.href', { timeoutMs: input.timeoutMs });
      tab.title = result.title;
      tab.session.lastSnapshot = null;
      tab.documentRevision += 1;
      tab.guideSelections.clear();
      return { ...result, url: tab.url };
    });
  }

  /** @param {{owner:unknown,tabId:string,lease:string,expression:string,timeoutMs?:number,awaitPromise?:boolean}} input */
  evaluate(input) {
    return this.#run(input, 'evaluate', (tab) => tab.session.evaluate(input.expression, {
      timeoutMs: input.timeoutMs,
      awaitPromise: input.awaitPromise !== false,
    }));
  }

  /** @param {{owner:unknown,tabId:string,lease:string,timeoutMs?:number}} input */
  snapshot(input) {
    return this.#run(input, 'snapshot', (tab) => tab.session.snapshot({ timeoutMs: input.timeoutMs }));
  }

  /** @param {{owner:unknown,tabId:string,lease:string,uid:number,timeoutMs?:number}} input */
  click(input) {
    return this.#run(input, 'click', async (tab) => {
      const { node, objectId } = await resolveNode(tab.session, input.uid, input.timeoutMs);
      try {
        await callOn(tab.session, objectId, 'function () { this.scrollIntoView?.({block:"center"}); if (typeof this.click !== "function") throw new Error("element is not clickable"); this.click(); return true; }', input.timeoutMs);
      } finally {
        await releaseObject(tab.session, objectId);
      }
      tab.session.lastSnapshot = null;
      tab.documentRevision += 1;
      tab.guideSelections.clear();
      return { uid: input.uid, role: node.role, name: node.name };
    });
  }

  /** @param {{owner:unknown,tabId:string,lease:string,uid:number,text:string,clear?:boolean,submit?:boolean,timeoutMs?:number}} input */
  fill(input) {
    return this.#run(input, 'fill', async (tab) => {
      if (typeof input.text !== 'string') throw new AgentBrowserError('text is required', 'invalid');
      const { node, objectId } = await resolveNode(tab.session, input.uid, input.timeoutMs);
      try {
        await callOn(tab.session, objectId, `function () { this.scrollIntoView?.({block:"center"}); this.focus?.(); if (${input.clear !== false} && typeof this.select === "function") this.select(); return true; }`, input.timeoutMs);
        await tab.session.client.send('Input.insertText', { text: input.text }, { timeoutMs: input.timeoutMs });
        if (input.submit === true) {
          for (const type of ['keyDown', 'keyUp']) {
            await tab.session.client.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, { timeoutMs: input.timeoutMs });
          }
        }
      } finally {
        await releaseObject(tab.session, objectId);
      }
      tab.session.lastSnapshot = null;
      tab.documentRevision += 1;
      tab.guideSelections.clear();
      return { uid: input.uid, role: node.role, name: node.name, length: input.text.length };
    });
  }

  /** @param {{owner:unknown,tabId:string,lease:string,timeoutMs?:number}} input */
  screenshot(input) {
    return this.#run(input, 'screenshot', (tab) => tab.session.screenshot({ timeoutMs: input.timeoutMs }));
  }

  /** @param {{owner:unknown,tabId:string,lease:string}} input */
  releaseOwnedTab(input) {
    this.#reservation(input);
    return this.unassignTab(input.tabId);
  }

  /** @param {{owner:unknown,tabId:string,lease:string}} input */
  async closeOwnedTab(input) {
    this.#reservation(input);
    await this.closeTab(input.tabId);
  }

  /** @param {string} tabId @param {'watch'|'guide'|'control'} mode */
  async setControlMode(tabId, mode) {
    if (!['watch', 'guide', 'control'].includes(mode)) {
      throw new AgentBrowserError('control mode must be watch, guide, or control', 'invalid');
    }
    const tab = this.#tab(tabId);
    if (tab.status !== 'ready') throw new AgentBrowserError(`tab is ${tab.status}`, 'busy');
    if (tab.controlMode === mode) return publicTab(tab);
    const revision = ++tab.revision;
    tab.status = 'transferring';
    tab.controlMode = mode;
    if (mode !== 'guide') tab.guideSelections.clear();
    tab.updatedAt = Date.now();
    this.#changed(tab);
    await tab.tail.catch(() => {});
    if (this.tabs.get(tabId) !== tab || tab.status !== 'transferring' || tab.revision !== revision) {
      throw new AgentBrowserError('tab changed while switching control mode', 'closed');
    }
    if (!tab.session?.alive) throw new AgentBrowserError('browser ended while switching control mode', 'unsafe-transfer');
    tab.status = 'ready';
    tab.updatedAt = Date.now();
    this.#changed(tab);
    return publicTab(tab);
  }

  /** @param {string} tabId @param {{timeoutMs?:number}} [opts] */
  captureFrame(tabId, opts = {}) {
    return this.#runOperator(tabId, 'capture-frame', null, async (tab) => {
      const result = await tab.session.client.send(
        'Page.captureScreenshot',
        { format: 'png', fromSurface: true, captureBeyondViewport: false },
        { timeoutMs: opts.timeoutMs },
      );
      if (typeof result.data !== 'string' || !result.data) {
        throw new AgentBrowserError('browser returned no screenshot frame', 'invalid');
      }
      const png = Buffer.from(result.data, 'base64');
      const frame = pngDimensions(png);
      tab.frameRevision += 1;
      return {
        png,
        pngBase64: result.data,
        width: frame.width,
        height: frame.height,
        viewport: frame,
        capturedAt: Date.now(),
        revision: tab.frameRevision,
      };
    });
  }

  /** @param {string} tabId @param {{x:number,y:number,message?:string,timeoutMs?:number}} input */
  guideElementAtPoint(tabId, input) {
    return this.#runOperator(tabId, 'guide-select', ['guide'], async (tab) => {
      if (!tab.owner) throw new AgentBrowserError('assign the tab before guiding its agent', 'not-owner');
      const x = finiteNumber(input.x, tab.viewport.width);
      const y = finiteNumber(input.y, tab.viewport.height);
      if (x < 0 || y < 0 || x > tab.viewport.width || y > tab.viewport.height) {
        throw new AgentBrowserError('guide point is outside the page viewport', 'invalid');
      }
      await tab.session.client.send('DOM.enable', {}, { timeoutMs: input.timeoutMs });
      const hit = await tab.session.client.send(
        'DOM.getNodeForLocation',
        { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true, ignorePointerEventsNone: true },
        { timeoutMs: input.timeoutMs },
      );
      const backendNodeId = Number(hit.backendNodeId ?? 0);
      if (!backendNodeId) throw new AgentBrowserError('no element exists at the guide point', 'invalid');
      const resolved = await tab.session.client.send('DOM.resolveNode', { backendNodeId }, { timeoutMs: input.timeoutMs });
      const objectId = resolved.object?.objectId;
      if (!objectId) throw new AgentBrowserError('guide element could not be resolved', 'invalid');
      let element;
      try {
        element = await callOn(
          tab.session,
          objectId,
          `function () {
            const text = String(this.innerText || this.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 500);
            const rect = this.getBoundingClientRect();
            const part = (el) => {
              if (el.id) return '#' + CSS.escape(el.id);
              let value = String(el.localName || '').toLowerCase();
              const cls = [...(el.classList || [])].slice(0, 2).map((name) => '.' + CSS.escape(name)).join('');
              value += cls;
              if (el.parentElement) value += ':nth-child(' + ([...el.parentElement.children].indexOf(el) + 1) + ')';
              return value;
            };
            const path = [];
            for (let el = this; el && el.nodeType === 1 && path.length < 5; el = el.parentElement) path.unshift(part(el));
            return {
              tagName: String(this.localName || '').toLowerCase(), id: this.id || '', className: String(this.className || ''),
              role: this.getAttribute('role') || '', ariaLabel: this.getAttribute('aria-label') || '', text,
              selector: path.join(' > '), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            };
          }`,
          input.timeoutMs,
        );
      } finally {
        await releaseObject(tab.session, objectId);
      }
      const selection = {
        selectionToken: randomUUID(),
        tabId,
        owner: tab.owner ? { ...tab.owner } : null,
        url: tab.url,
        point: { x, y },
        element,
        documentRevision: tab.documentRevision,
        frameRevision: tab.frameRevision,
        createdAt: Date.now(),
      };
      tab.guideSelections.clear();
      tab.guideSelections.set(selection.selectionToken, selection);
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      if (message) this.#emitGuide(tab, selection, message);
      return selection;
    });
  }

  /** @param {string} tabId @param {{point:{x:number,y:number},frameRevision?:number|string,viewport?:{width:number,height:number},timeoutMs?:number}} input */
  selectGuideElement(tabId, input) {
    const tab = this.#tab(tabId);
    if (input.frameRevision !== undefined && Number(input.frameRevision) !== tab.frameRevision) {
      throw new AgentBrowserError('viewer frame is stale; refresh it before selecting', 'invalid');
    }
    if (input.viewport && (Number(input.viewport.width) !== tab.viewport.width || Number(input.viewport.height) !== tab.viewport.height)) {
      throw new AgentBrowserError('viewer viewport is stale; refresh it before selecting', 'invalid');
    }
    return this.guideElementAtPoint(tabId, { ...input.point, timeoutMs: input.timeoutMs });
  }

  /** @param {string} tabId @param {{selectionToken:string,message:string}} input */
  deliverGuide(tabId, input) {
    return this.#runOperator(tabId, 'guide-deliver', ['guide'], async (tab) => {
      const selection = tab.guideSelections.get(String(input.selectionToken ?? ''));
      if (!selection) throw new AgentBrowserError('guide selection is stale; select the element again', 'invalid');
      if (!tab.owner || !sameOwner(selection.owner, tab.owner) || selection.documentRevision !== tab.documentRevision) {
        tab.guideSelections.delete(input.selectionToken);
        throw new AgentBrowserError('guide selection no longer belongs to this page and owner', 'stale-lease');
      }
      const message = requiredId(input.message, 'message');
      tab.guideSelections.delete(input.selectionToken);
      return this.#emitGuide(tab, selection, message);
    });
  }

  /** Compatibility helper for a one-step Guide caller. */
  async guide(tabId, input) {
    const selection = input.selectionToken
      ? { selectionToken: input.selectionToken }
      : await this.guideElementAtPoint(tabId, { ...(input.point ?? {}), timeoutMs: input.timeoutMs });
    return this.deliverGuide(tabId, { selectionToken: selection.selectionToken, message: input.message });
  }

  /** @param {unknown} owner */
  takeGuideEvents(owner) {
    const trustedOwner = normalizeOwner(owner);
    const matches = this.guideEvents.filter((event) => sameOwner(event.owner, trustedOwner));
    this.guideEvents = this.guideEvents.filter((event) => !sameOwner(event.owner, trustedOwner));
    return matches;
  }

  /** @param {string} tabId @param {string} url @param {{timeoutMs?:number}} [opts] */
  navigateOperator(tabId, url, opts = {}) {
    return this.#runOperator(tabId, 'user-navigate', ['control'], async (tab) => {
      tab.policyViolation = null;
      const result = await tab.session.navigate(url, opts);
      await Promise.allSettled([...tab.policyTasks]);
      if (tab.policyViolation) throw new BrowserDriverError(`navigation blocked by allowlist: ${tab.policyViolation}`, 'allowlist');
      tab.url = await tab.session.evaluate('location.href', opts);
      tab.title = result.title;
      tab.session.lastSnapshot = null;
      tab.documentRevision += 1;
      tab.guideSelections.clear();
      return { ...result, url: tab.url };
    });
  }

  operatorNavigate(tabId, url, opts = {}) {
    return this.navigateOperator(tabId, url, opts);
  }

  operatorBack(tabId, opts = {}) {
    return this.historyOperator(tabId, 'back', opts);
  }

  operatorForward(tabId, opts = {}) {
    return this.historyOperator(tabId, 'forward', opts);
  }

  operatorReload(tabId, opts = {}) {
    return this.historyOperator(tabId, 'reload', opts);
  }

  /** @param {string} tabId @param {Record<string,unknown>} event @param {{timeoutMs?:number}} [opts] */
  operatorInput(tabId, event, opts = {}) {
    const type = String(event.type ?? event.kind ?? '');
    const translated = {
      ...event,
      kind: type,
      action: event.action ?? event.phase,
    };
    if (event.modifiers && typeof event.modifiers === 'object') {
      const modifiers = /** @type {Record<string,unknown>} */ (event.modifiers);
      translated.modifiers = (modifiers.alt ? 1 : 0) | (modifiers.ctrl ? 2 : 0) | (modifiers.meta ? 4 : 0) | (modifiers.shift ? 8 : 0);
    }
    return this.dispatchControlInput(tabId, translated, opts);
  }

  /** @param {string} tabId @param {'back'|'forward'|'reload'} action @param {{timeoutMs?:number}} [opts] */
  historyOperator(tabId, action, opts = {}) {
    if (!['back', 'forward', 'reload'].includes(action)) {
      throw new AgentBrowserError('history action must be back, forward, or reload', 'invalid');
    }
    return this.#runOperator(tabId, `user-${action}`, ['control'], async (tab) => {
      if (action === 'reload') {
        await tab.session.client.send('Page.reload', {}, { timeoutMs: opts.timeoutMs });
      } else {
        const history = await tab.session.client.send('Page.getNavigationHistory', {}, { timeoutMs: opts.timeoutMs });
        const offset = action === 'back' ? -1 : 1;
        const entry = history.entries?.[Number(history.currentIndex) + offset];
        if (!entry) return { moved: false, url: tab.url };
        if (!isAllowedPageUrl(String(entry.url ?? ''), tab.session.allowedOriginPatterns)) {
          throw new BrowserDriverError(`navigation blocked by allowlist: ${entry.url}`, 'allowlist');
        }
        await tab.session.client.send('Page.navigateToHistoryEntry', { entryId: entry.id }, { timeoutMs: opts.timeoutMs });
      }
      tab.session.lastSnapshot = null;
      tab.documentRevision += 1;
      tab.guideSelections.clear();
      return { moved: true, url: tab.url };
    });
  }

  /** @param {string} tabId @param {Record<string,unknown>} event @param {{timeoutMs?:number}} [opts] */
  dispatchControlInput(tabId, event, opts = {}) {
    return this.#runOperator(tabId, 'user-input', ['control'], async (tab) => {
      const kind = String(event.kind ?? '');
      if (kind === 'text') {
        const text = requiredId(event.text, 'event.text');
        await tab.session.client.send('Input.insertText', { text }, { timeoutMs: opts.timeoutMs });
      } else if (kind === 'pointer') {
        const action = String(event.action ?? 'move');
        const x = finiteNumber(event.x, tab.viewport.width);
        const y = finiteNumber(event.y, tab.viewport.height);
        const button = ['left', 'middle', 'right', 'none'].includes(String(event.button)) ? String(event.button) : 'none';
        if (action === 'click') {
          await tab.session.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: button === 'none' ? 'left' : button, clickCount: 1 }, { timeoutMs: opts.timeoutMs });
          await tab.session.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: button === 'none' ? 'left' : button, clickCount: 1 }, { timeoutMs: opts.timeoutMs });
        } else {
          const type = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[action];
          if (!type) throw new AgentBrowserError('unknown pointer action', 'invalid');
          await tab.session.client.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: Number(event.clickCount ?? 0) }, { timeoutMs: opts.timeoutMs });
        }
      } else if (kind === 'wheel') {
        await tab.session.client.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: finiteNumber(event.x ?? tab.viewport.width / 2, tab.viewport.width), y: finiteNumber(event.y ?? tab.viewport.height / 2, tab.viewport.height),
          deltaX: finiteNumber(event.deltaX ?? 0, 100_000), deltaY: finiteNumber(event.deltaY ?? 0, 100_000),
        }, { timeoutMs: opts.timeoutMs });
      } else if (kind === 'key') {
        const implicitPress = event.action == null;
        const action = String(event.action ?? 'down');
        const type = { down: 'keyDown', up: 'keyUp', char: 'char' }[action];
        if (!type) throw new AgentBrowserError('unknown key action', 'invalid');
        await tab.session.client.send('Input.dispatchKeyEvent', {
          type, key: String(event.key ?? ''), code: String(event.code ?? ''), text: String(event.text ?? ''),
          windowsVirtualKeyCode: Number(event.windowsVirtualKeyCode ?? 0), modifiers: Number(event.modifiers ?? 0),
        }, { timeoutMs: opts.timeoutMs });
        if (implicitPress) {
          await tab.session.client.send('Input.dispatchKeyEvent', {
            type: 'keyUp', key: String(event.key ?? ''), code: String(event.code ?? ''),
            windowsVirtualKeyCode: Number(event.windowsVirtualKeyCode ?? 0), modifiers: Number(event.modifiers ?? 0),
          }, { timeoutMs: opts.timeoutMs });
        }
      } else {
        throw new AgentBrowserError('control input kind must be text, pointer, wheel, or key', 'invalid');
      }
      tab.session.lastSnapshot = null;
      tab.documentRevision += 1;
      tab.guideSelections.clear();
      return { ok: true };
    });
  }

  /** Release ownership but leave the disposable browser open for inspection. */
  releaseTab(tabId) {
    return this.unassignTab(tabId);
  }

  /** @param {string} tabId */
  async unassignTab(tabId) {
    return this.#transfer(tabId, null);
  }

  /** @param {string} tabId @param {unknown} owner */
  async reassignTab(tabId, owner) {
    return this.#transfer(tabId, normalizeOwner(owner));
  }

  /** @param {string} tabId */
  async closeTab(tabId) {
    const tab = this.#tab(tabId);
    if (tab.closePromise) return tab.closePromise;
    tab.closePromise = (async () => {
      tab.status = 'closing';
      tab.revision += 1;
      tab.lease = null;
      tab.owner = null;
      tab.updatedAt = Date.now();
      this.#changed(tab);
      await tab.launchPromise?.catch(() => {});
      await tab.tail.catch(() => {});
      await Promise.allSettled([...tab.policyTasks]);
      tab.browserClient?.close('agent browser tab closed');
      if (tab.session) await tab.session.close();
      if (this.tabs.get(tabId) === tab) this.tabs.delete(tabId);
      this.emit('tabs-changed', this.listTabs());
    })();
    return tab.closePromise;
  }

  async clearTabs() {
    await Promise.allSettled([...this.tabs.keys()].map((tabId) => this.closeTab(tabId)));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.clearTabs();
    this.removeAllListeners();
  }

  /** @param {string} tabId */
  #tab(tabId) {
    const tab = this.tabs.get(String(tabId ?? ''));
    if (!tab) throw new AgentBrowserError(`unknown agent browser tab: ${tabId}`, 'not-found');
    return tab;
  }

  /** @param {any} input */
  #reservation(input) {
    const tab = this.#tab(input.tabId);
    const owner = normalizeOwner(input.owner);
    if (!sameOwner(tab.owner, owner)) throw new AgentBrowserError('tab is reserved by another owner', 'not-owner');
    if (!input.lease || input.lease !== tab.lease) throw new AgentBrowserError('tab lease is stale', 'stale-lease');
    if (tab.status !== 'ready') throw new AgentBrowserError(`tab is ${tab.status}`, 'busy');
    if (tab.controlMode !== 'watch') throw new AgentBrowserError(`tab is in ${tab.controlMode} mode`, 'busy');
    return { tab, owner, revision: tab.revision, lease: input.lease };
  }

  /** @param {any} input @param {string} action @param {(tab:any)=>Promise<any>} operation */
  #run(input, action, operation) {
    const reservation = this.#reservation(input);
    const queued = reservation.tab.tail.catch(() => {}).then(async () => {
      const { tab } = reservation;
      if (tab.revision !== reservation.revision || tab.lease !== reservation.lease || !sameOwner(tab.owner, reservation.owner)) {
        throw new AgentBrowserError('queued command was revoked before it started', 'stale-lease');
      }
      const active = { revision: reservation.revision, action, startedAt: Date.now() };
      tab.active = active;
      this.#changed(tab);
      try {
        await this.#assertCurrentUrlAllowed(tab, input.timeoutMs);
        const result = await operation(tab);
        if (result && typeof result === 'object' && result.ok === false && isUncertainProtocolFailure(result.error)) {
          await this.#quarantine(tab, result.error);
        }
        return result;
      } catch (error) {
        if (isUncertainProtocolFailure(error)) await this.#quarantine(tab, error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        if (tab.active === active) tab.active = null;
        tab.updatedAt = Date.now();
        this.#changed(tab);
      }
    });
    reservation.tab.tail = queued.catch(() => {});
    return queued;
  }

  /** @param {string} tabId @param {string} action @param {string[] | null} modes @param {(tab:any)=>Promise<any>} operation */
  #runOperator(tabId, action, modes, operation) {
    const tab = this.#tab(tabId);
    if (tab.status !== 'ready') throw new AgentBrowserError(`tab is ${tab.status}`, 'busy');
    if (modes && !modes.includes(tab.controlMode)) {
      throw new AgentBrowserError(`${action} requires ${modes.join(' or ')} mode`, 'busy');
    }
    const revision = tab.revision;
    const queued = tab.tail.catch(() => {}).then(async () => {
      if (this.tabs.get(tabId) !== tab || tab.status !== 'ready' || tab.revision !== revision) {
        throw new AgentBrowserError('operator command was revoked before it started', 'busy');
      }
      const active = { revision, action, startedAt: Date.now() };
      tab.active = active;
      this.#changed(tab);
      try {
        await this.#assertCurrentUrlAllowed(tab);
        return await operation(tab);
      } catch (error) {
        if (isUncertainProtocolFailure(error)) await this.#quarantine(tab, error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        if (tab.active === active) tab.active = null;
        tab.updatedAt = Date.now();
        this.#changed(tab);
      }
    });
    tab.tail = queued.catch(() => {});
    return queued;
  }

  /** @param {any} tab @param {number | undefined} timeoutMs */
  async #assertCurrentUrlAllowed(tab, timeoutMs) {
    if (tab.policyViolation) {
      const blocked = tab.policyViolation;
      tab.policyViolation = null;
      throw new BrowserDriverError(`navigation blocked by allowlist: ${blocked}`, 'allowlist');
    }
    const url = String(await tab.session.evaluate('location.href', { timeoutMs }) ?? 'about:blank');
    if (!isAllowedPageUrl(url, tab.session.allowedOriginPatterns)) {
      throw new BrowserDriverError(`page left the browser allowlist: ${url}`, 'allowlist');
    }
    tab.url = url;
  }

  /** @param {any} tab @param {string} detail */
  async #quarantine(tab, detail) {
    if (tab.status === 'unsafe' || tab.status === 'closing') return;
    tab.status = 'unsafe';
    tab.revision += 1;
    tab.lease = null;
    tab.unsafeDetail = detail;
    tab.updatedAt = Date.now();
    this.#changed(tab);
    tab.browserClient?.close('unsafe agent browser command');
    await tab.session?.kill('unresponsive', `unsafe command completion: ${detail}`);
  }

  /** @param {string} tabId @param {ReturnType<typeof normalizeOwner> | null} owner */
  async #transfer(tabId, owner) {
    const tab = this.#tab(tabId);
    if (tab.status !== 'ready') throw new AgentBrowserError(`tab is ${tab.status}`, 'busy');
    tab.status = 'transferring';
    const revision = ++tab.revision;
    tab.lease = null;
    tab.updatedAt = Date.now();
    this.#changed(tab);
    await tab.tail.catch(() => {});
    if (this.tabs.get(tabId) !== tab || tab.status !== 'transferring' || tab.revision !== revision) {
      throw new AgentBrowserError('tab changed during ownership transfer', 'closed');
    }
    if (!tab.session?.alive) throw new AgentBrowserError('browser ended during ownership transfer', 'unsafe-transfer');
    tab.owner = owner;
    tab.lease = owner ? randomUUID() : null;
    tab.guideSelections.clear();
    tab.status = 'ready';
    tab.updatedAt = Date.now();
    this.#changed(tab);
    return { tab: publicTab(tab), lease: tab.lease };
  }

  /** @param {any} tab @param {any} selection @param {string} message */
  #emitGuide(tab, selection, message) {
    const event = {
      type: 'guide',
      guideId: randomUUID(),
      ...selection,
      owner: tab.owner ? { ...tab.owner } : null,
      message,
      createdAt: Date.now(),
    };
    this.guideEvents.push(event);
    if (this.guideEvents.length > 200) this.guideEvents.shift();
    this.emit('guide', event);
    return event;
  }

  /** @param {any} tab */
  #changed(tab) {
    this.emit('tab-changed', publicTab(tab));
    this.emit('tabs-changed', this.listTabs());
  }
}

/** @param {ConstructorParameters<typeof AgentBrowserService>[0]} [opts] */
export function createAgentBrowserService(opts) {
  return new AgentBrowserService(opts);
}
