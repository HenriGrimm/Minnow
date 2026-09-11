import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { AgentBrowserError, createAgentBrowserService } from './agent-browser/index.js';
import {
  consumeEphemeralNavigation,
  isNavigationAllowed,
  originFromUrl,
  suggestAllowlistPattern,
} from './cdp/allowlist.js';
import { loadBrowserConfig } from './cdp/browser-config.js';
import { readChatSummaries } from './config/sessions-repo.js';

export const AGENT_BROWSER_TOOL_NAMES = Object.freeze([
  'browser_reserve_tab',
  'browser_release_tab',
  'browser_list',
  'browser_navigate',
  'browser_new_tab',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_eval',
  'browser_screenshot',
]);

const AGENT_BROWSER_TOOL_SET = new Set(AGENT_BROWSER_TOOL_NAMES);
const leases = new Map();
const runtimes = new Map();
const runtimeTokens = new Map();
const pendingGuides = new Map();
const targetTokens = new Map();
const assignmentTargetIds = new Map();
const guideSelectionTokens = new Map();
let service = null;

function requiredId(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} is required`);
  return text;
}

export function normalizeAgentBrowserOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('trusted runtime owner is required');
  }
  return Object.freeze({
    chatId: requiredId(value.chatId, 'runtimeOwner.chatId'),
    runId: requiredId(value.runId, 'runtimeOwner.runId'),
    agentId: requiredId(value.agentId, 'runtimeOwner.agentId'),
  });
}

function ownerKey(owner) {
  return `${owner.chatId}\0${owner.runId}\0${owner.agentId}`;
}

function assignmentKey(owner, kind = 'chat') {
  return kind === 'chat' ? `chat\0${owner.chatId}` : `${kind}\0${ownerKey(owner)}`;
}

function leaseKey(owner, tabId) {
  return `${ownerKey(owner)}\0${tabId}`;
}

function deleteLeasesForTab(tabId) {
  const suffix = `\0${tabId}`;
  for (const key of leases.keys()) {
    if (key.endsWith(suffix)) leases.delete(key);
  }
}

function sameOwner(left, right) {
  return Boolean(
    left &&
      right &&
      left.chatId === right.chatId &&
      left.runId === right.runId &&
      left.agentId === right.agentId,
  );
}

function getService() {
  if (!service) service = createAgentBrowserService();
  return service;
}

export function getAgentBrowserService() {
  return getService();
}

export function setAgentBrowserServiceForTests(nextService) {
  service = nextService;
}

export function isAgentBrowserTool(name) {
  return AGENT_BROWSER_TOOL_SET.has(name);
}

function runtimeFor(owner) {
  return runtimes.get(ownerKey(owner)) ?? null;
}

function canRebindFrom(previous, next) {
  if (!previous || previous.chatId !== next.chatId) return false;
  const nextRuntime = runtimeFor(next);
  if (!nextRuntime || nextRuntime.kind !== 'chat') return false;
  if (previous.runId === 'idle') return true;
  const oldRuntime = runtimeFor(previous);
  if (oldRuntime?.kind !== 'chat') return false;
  if (oldRuntime && oldRuntime.ended !== true) return false;
  // The foreground client closes only from the turn's finally block. This
  // explicit lifecycle signal is stronger than the chat-wide generation store:
  // a newly-started turn may already have a generation row for the same chat.
  return true;
}

async function rebindDormantTabs(owner) {
  const browser = getService();
  for (const tab of browser.listTabs()) {
    if (sameOwner(tab.owner, owner)) continue;
    if (!canRebindFrom(tab.owner, owner)) continue;
    const reservation = await browser.reassignTab(tab.tabId, owner);
    deleteLeasesForTab(tab.tabId);
    if (reservation.lease) leases.set(leaseKey(owner, tab.tabId), reservation.lease);
  }
}

function enqueuePendingGuide(key, guide) {
  const queue = pendingGuides.get(key) ?? [];
  queue.push(guide);
  pendingGuides.set(key, queue.slice(-50));
  while (pendingGuides.size > 512) pendingGuides.delete(pendingGuides.keys().next().value);
}

function stableTarget(owner, kind, status, label) {
  const key = assignmentKey(owner, kind);
  let targetId = assignmentTargetIds.get(key);
  if (!targetId) {
    targetId = randomUUID();
    assignmentTargetIds.set(key, targetId);
  }
  targetTokens.set(targetId, { owner, kind, status, expiresAt: Date.now() + 60_000 });
  while (targetTokens.size > 512) targetTokens.delete(targetTokens.keys().next().value);
  return { targetId, kind, status, label };
}

function pruneRuntimeTombstones() {
  const owned = new Set((service?.listTabs?.() ?? []).filter((tab) => tab.owner).map((tab) => ownerKey(tab.owner)));
  for (const [key, runtime] of runtimes) {
    if (runtime.ended && !owned.has(key)) runtimes.delete(key);
  }
}

function emitRuntimeEvent(runtime, event) {
  const res = runtime.connection;
  if (!res) return;
  try {
    res.write(`id: ${event.id}\nevent: guide\ndata: ${JSON.stringify(event)}\n\n`);
  } catch {
  }
}

function writeRuntimeEvent(res, event) {
  res.write(`id: ${event.id}\nevent: guide\ndata: ${JSON.stringify(event)}\n\n`);
}

function deliverQueuedGuides(runtime) {
  const exact = pendingGuides.get(ownerKey(runtime.owner)) ?? [];
  const assigned = runtime.kind === 'chat'
    ? pendingGuides.get(assignmentKey(runtime.owner, 'chat')) ?? []
    : [];
  pendingGuides.delete(ownerKey(runtime.owner));
  if (runtime.kind === 'chat') pendingGuides.delete(assignmentKey(runtime.owner, 'chat'));
  for (const guide of [...exact, ...assigned]) {
    runtime.guides.push(guide);
    emitRuntimeEvent(runtime, guide);
  }
}

export async function registerAgentBrowserRuntime(rawOwner, options = {}) {
  pruneRuntimeTombstones();
  const owner = normalizeAgentBrowserOwner(rawOwner);
  const key = ownerKey(owner);
  const existing = runtimes.get(key);
  if (existing && existing.ended !== true) return existing.handle;

  const runtime = {
    owner,
    kind: options.kind === 'board' || options.kind === 'subagent' ? options.kind : 'chat',
    token: randomUUID(),
    connection: null,
    guides: [],
    acked: new Set(),
    ended: false,
    lastHeartbeatAt: Date.now(),
  };
  runtime.handle = {
    owner,
    token: runtime.token,
    drainGuides() {
      const rows = runtime.guides.splice(0);
      for (const row of rows) runtime.acked.add(row.id);
      return rows;
    },
    close() {
      if (runtime.ended) return;
      runtime.ended = true;
      if (runtime.kind === 'chat') {
        for (const guide of runtime.guides) {
          if (!runtime.acked.has(guide.id)) {
            enqueuePendingGuide(assignmentKey(runtime.owner, 'chat'), guide);
          }
        }
      }
      try { runtime.connection?.end(); } catch {}
      runtime.connection = null;
      runtimeTokens.delete(runtime.token);
    },
  };
  runtimes.set(key, runtime);
  runtimeTokens.set(runtime.token, runtime);
  await rebindDormantTabs(owner);
  deliverQueuedGuides(runtime);
  return runtime.handle;
}

export function unregisterAgentBrowserRuntime(rawOwner) {
  const owner = normalizeAgentBrowserOwner(rawOwner);
  const runtime = runtimeFor(owner);
  if (!runtime) return false;
  runtime.handle.close();
  return true;
}

async function browserConfigForNavigation(url) {
  const config = await loadBrowserConfig();
  if (!config.enabled) throw new Error('browser automation is disabled in settings');
  if (!config.allowNavigate) throw new Error('browser navigation is disabled in settings');
  if (!isNavigationAllowed(url, config.allowedOriginPatterns)) {
    let origin = url;
    try { origin = originFromUrl(url); } catch {}
    throw new Error(
      `navigation blocked by allowlist: ${origin} (suggested pattern: ${suggestAllowlistPattern(url)})`,
    );
  }
  return config;
}

async function refreshTrustedTabPolicy(browser, tabId, navigationUrl) {
  const config = navigationUrl
    ? await browserConfigForNavigation(navigationUrl)
    : await loadBrowserConfig();
  if (!config.enabled) throw new Error('browser automation is disabled in settings');
  browser.updateTabPolicy(tabId, config.allowedOriginPatterns);
  return config;
}

function tabIdFrom(args) {
  return requiredId(args?.tab_id ?? args?.tabId, 'tab_id');
}

function timeoutFrom(args) {
  const value = Number(args?.timeout_ms ?? args?.timeoutMs);
  return Number.isFinite(value) && value > 0 ? Math.min(120_000, Math.floor(value)) : undefined;
}

function formatValue(value) {
  if (value === undefined) return '(undefined)';
  if (typeof value === 'object' && value !== null) {
    try { return JSON.stringify(value, null, 2); } catch {}
  }
  return String(value);
}

async function requireLease(owner, tabId) {
  let lease = leases.get(leaseKey(owner, tabId));
  if (lease) return lease;
  await rebindDormantTabs(owner);
  lease = leases.get(leaseKey(owner, tabId));
  if (!lease) throw new Error(`agent browser tab ${tabId} is not leased to this runtime`);
  return lease;
}

async function navigateOwned(browser, owner, tabId, lease, url, timeoutMs) {
  await refreshTrustedTabPolicy(browser, tabId, url);
  const out = await browser.navigate({ owner, tabId, lease, url, timeoutMs });
  consumeEphemeralNavigation(originFromUrl(url));
  return `Navigated to: ${out.url}\nTitle: ${out.title || '(no title)'}\nOutcome: ${out.outcome}`;
}

export async function executeAgentBrowserTool(name, args = {}, options = {}) {
  if (!isAgentBrowserTool(name)) return null;
  const surface = args?.surface == null ? 'agent' : String(args.surface);
  if (surface !== 'agent' && surface !== 'user') {
    return { result: 'Error: surface must be "agent" or "user"' };
  }
  if (surface === 'user') {
    return { result: 'Error: the user browser surface is only available in the renderer' };
  }
  const owner = normalizeAgentBrowserOwner(options.runtimeOwner);
  const browser = getService();
  const timeoutMs = timeoutFrom(args);

  try {
    if (name === 'browser_reserve_tab' || name === 'browser_new_tab') {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (url) await browserConfigForNavigation(url);
      else {
        const config = await loadBrowserConfig();
        if (!config.enabled) throw new Error('browser automation is disabled in settings');
      }
      const width = Number(args.width);
      const height = Number(args.height);
      const viewport = Number.isFinite(width) || Number.isFinite(height)
        ? { width: Number.isFinite(width) ? width : 1440, height: Number.isFinite(height) ? height : 900 }
        : undefined;
      const reservation = await browser.reserveTab(owner, { viewport });
      if (!reservation.lease) throw new Error('browser reservation did not return a lease');
      leases.set(leaseKey(owner, reservation.tab.tabId), reservation.lease);
      let navigation = '';
      if (url) {
        try {
          navigation = `\n${await navigateOwned(browser, owner, reservation.tab.tabId, reservation.lease, url, timeoutMs)}`;
        } catch (error) {
          await browser.closeOwnedTab({ owner, tabId: reservation.tab.tabId, lease: reservation.lease }).catch(() => null);
          leases.delete(leaseKey(owner, reservation.tab.tabId));
          throw error;
        }
      }
      return { result: `Reserved agent browser tab ${reservation.tab.tabId}${navigation}` };
    }

    if (name === 'browser_list') {
      const tabs = browser.listOwnedTabs
        ? browser.listOwnedTabs(owner)
        : browser.listTabs().filter((tab) => sameOwner(tab.owner, owner));
      const result = tabs.length
        ? tabs.map((tab) => `${tab.title || '(no title)'}\n  ${tab.url || 'about:blank'}\n  id: ${tab.tabId}`).join('\n\n')
        : '(no owned agent browser tabs)';
      return { result };
    }

    const tabId = tabIdFrom(args);
    const lease = await requireLease(owner, tabId);
    const call = { owner, tabId, lease, timeoutMs };

    if (name === 'browser_release_tab') {
      const out = browser.releaseOwnedTab
        ? await browser.releaseOwnedTab(call)
        : await browser.releaseTab(tabId);
      leases.delete(leaseKey(owner, tabId));
      return { result: `Released agent browser tab ${out.tab.tabId}` };
    }
    if (name === 'browser_close_tab') {
      if (browser.closeOwnedTab) await browser.closeOwnedTab(call);
      else await browser.closeTab(tabId);
      leases.delete(leaseKey(owner, tabId));
      return { result: `Closed agent browser tab ${tabId}` };
    }
    if (name === 'browser_switch_tab') {
      const tab = browser.inspectOwnedTab
        ? browser.inspectOwnedTab(call)
        : browser.listTabs().find((row) => row.tabId === tabId && sameOwner(row.owner, owner));
      if (!tab) throw new Error(`agent browser tab ${tabId} is not owned by this runtime`);
      return { result: `Agent tab: ${tab.tabId}\nTitle: ${tab.title || '(no title)'}\n${tab.url}` };
    }
    await refreshTrustedTabPolicy(browser, tabId);
    if (name === 'browser_navigate') {
      const url = requiredId(args.url, 'url');
      return { result: await navigateOwned(browser, owner, tabId, lease, url, timeoutMs) };
    }
    if (name === 'browser_snapshot') {
      const snapshot = await browser.snapshot(call);
      return { result: snapshot.text || '(empty page)' };
    }
    if (name === 'browser_click') {
      const out = await browser.click({ ...call, uid: Number(args.uid) });
      return { result: `Clicked [${out.uid}] ${out.role}${out.name ? ` "${out.name}"` : ''}` };
    }
    if (name === 'browser_fill') {
      const text = args.value != null ? String(args.value) : '';
      const out = await browser.fill({ ...call, uid: Number(args.uid), text, clear: args.clear !== false, submit: args.submit === true });
      return { result: `Filled [${out.uid}] ${out.role}${out.name ? ` "${out.name}"` : ''} with ${out.length} characters` };
    }
    if (name === 'browser_eval') {
      const expression = requiredId(args.expression, 'expression');
      const value = await browser.evaluate({ ...call, expression, awaitPromise: true });
      return { result: formatValue(value) };
    }
    if (name === 'browser_screenshot') {
      const shot = await browser.screenshot(call);
      if (!shot.ok) return { result: `Error: screenshot not captured (${shot.error})` };
      const data = await fs.readFile(shot.filePath);
      const url = `/api/browser/screenshot/${shot.id}`;
      return {
        result: `Screenshot saved: ${shot.id}.png\nURL: ${url}\n(${Math.round(shot.sizeBytes / 1024)} KB)`,
        attachments: [{ type: 'image', url, mime: 'image/png', alt: 'Agent browser screenshot', dataUrl: `data:image/png;base64,${data.toString('base64')}` }],
      };
    }
    return { result: `Not implemented: ${name}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = message.startsWith('Error:') ? message : `Error: ${message}`;
    // Without this, models retry on surface="user" and drive the user's own preview tab.
    if (error instanceof AgentBrowserError && error.code === 'launch-failed') return { result: `${text}\n${AGENT_BROWSER_UNAVAILABLE_HINT}` };
    return { result: text };
  }
}

export const AGENT_BROWSER_UNAVAILABLE_HINT =
  'The isolated Agent Browser could not start. Do NOT retry with surface="user": that drives the ' +
  "user's own visible preview tab. Stop browsing and tell the user the Agent Browser needs Google " +
  'Chrome, Microsoft Edge, Brave, or Chromium installed (or MINNOW_BROWSER_PATH set to one).';

function elementSummary(element) {
  if (!element || typeof element !== 'object') return '';
  const role = typeof element.role === 'string' ? element.role.trim() : '';
  const label = typeof element.ariaLabel === 'string' && element.ariaLabel.trim()
    ? element.ariaLabel.trim()
    : typeof element.text === 'string'
      ? element.text.trim().replace(/\s+/g, ' ').slice(0, 120)
      : '';
  const tag = typeof element.tagName === 'string'
    ? element.tagName.toLowerCase()
    : typeof element.tag === 'string'
      ? element.tag.toLowerCase()
      : '';
  return [role || tag, label && `“${label}”`].filter(Boolean).join(' ') || 'page element';
}

export function formatAgentBrowserGuideForTranscript(guide) {
  const lines = [`Browser Guide for tab ${guide.tabId}: ${guide.message}`];
  const summary = typeof guide.elementSummary === 'string' && guide.elementSummary.trim()
    ? guide.elementSummary.trim()
    : elementSummary(guide.element);
  if (summary) lines.push(`Selected element: ${summary}`);
  else if (guide.point && Number.isFinite(Number(guide.point.x)) && Number.isFinite(Number(guide.point.y))) {
    lines.push(`Selected point: (${Number(guide.point.x)}, ${Number(guide.point.y)})`);
  }
  if (typeof guide.url === 'string' && guide.url.trim()) lines.push(`Page: ${guide.url.trim()}`);
  return lines.join('\n');
}

function ownerLabel(owner, kind = 'chat') {
  if (!owner) return 'Unassigned';
  const chat = kind === 'chat'
    ? readChatSummaries().find((row) => row.id === owner.chatId)
    : null;
  return kind === 'chat'
    ? (typeof chat?.name === 'string' && chat.name.trim() ? chat.name.trim() : `Chat ${owner.chatId}`)
    : `${kind === 'board' ? 'Board agent' : 'Subagent'} ${owner.agentId}`;
}

function tabWithOwnerLabel(tab) {
  if (!tab.owner) return tab;
  const runtime = runtimeFor(tab.owner);
  return { ...tab, owner: { ...tab.owner, label: ownerLabel(tab.owner, runtime?.kind) } };
}

async function selectGuideTarget(tabId, body) {
  const browser = getService();
  await refreshTrustedTabPolicy(browser, tabId);
  const tab = browser.listTabs().find((row) => row.tabId === tabId);
  if (!tab) throw new Error(`unknown agent browser tab: ${tabId}`);
  if (!tab.owner) throw new Error('assign this tab to an agent before sending Guide');
  const point = body?.point && typeof body.point === 'object' ? body.point : {};
  const viewport = body?.viewport && typeof body.viewport === 'object' ? body.viewport : {};
  if (Number(viewport.width) !== Number(tab.viewport?.width) || Number(viewport.height) !== Number(tab.viewport?.height)) {
    throw new Error('the viewer size changed; select the element again');
  }
  if (String(body?.frameRevision ?? '') !== String(tab.frameRevision ?? '')) {
    throw new Error('the page frame changed; select the element again');
  }
  const selection = await browser.selectGuideElement(tabId, {
    point: { x: Number(point.x), y: Number(point.y) },
    frameRevision: body.frameRevision,
    viewport: { width: Number(viewport.width), height: Number(viewport.height) },
  });
  const selectionToken = randomUUID();
  const runtime = runtimeFor(tab.owner);
  const label = ownerLabel(tab.owner, runtime?.kind);
  guideSelectionTokens.set(selectionToken, {
    tabId,
    serviceSelectionToken: selection.selectionToken,
    owner: { ...tab.owner },
    ownerLabel: label,
    documentRevision: selection.documentRevision,
    expiresAt: Date.now() + 60_000,
  });
  return {
    selectionToken,
    element: elementSummary(selection.element),
    owner: label,
    documentRevision: selection.documentRevision,
  };
}

async function deliverGuide(tabId, body) {
  const token = requiredId(body?.selectionToken, 'selectionToken');
  const selected = guideSelectionTokens.get(token);
  guideSelectionTokens.delete(token);
  if (!selected || selected.expiresAt < Date.now() || selected.tabId !== tabId) {
    throw new Error('Guide selection expired; select the element again');
  }
  if (body.owner !== selected.ownerLabel || String(body.documentRevision) !== String(selected.documentRevision)) {
    throw new Error('Guide selection changed; select the element again');
  }
  const browser = getService();
  await refreshTrustedTabPolicy(browser, tabId);
  const tab = browser.listTabs().find((row) => row.tabId === tabId);
  if (!tab || !sameOwner(tab.owner, selected.owner)) {
    throw new Error('This tab was reassigned; select the element again');
  }
  const detail = await browser.deliverGuide(tabId, {
    selectionToken: selected.serviceSelectionToken,
    message: requiredId(body.message, 'message'),
  });
  const runtime = runtimeFor(tab.owner);
  const guide = {
    id: randomUUID(),
    tabId,
    message: body.message.trim(),
    point: detail.point ?? null,
    element: detail.element ?? null,
    elementSummary: elementSummary(detail.element),
    url: detail.url ?? tab.url,
    createdAt: Date.now(),
  };
  if (runtime && runtime.ended !== true) {
    runtime.guides.push(guide);
    emitRuntimeEvent(runtime, guide);
    return { outcome: 'delivered', owner: ownerLabel(tab.owner, runtime.kind), element: guide.elementSummary, guideId: guide.id };
  }
  if (tab.owner.runId === 'idle' || runtime?.kind === 'chat') {
    enqueuePendingGuide(assignmentKey(tab.owner, 'chat'), guide);
    return { outcome: 'queued', owner: ownerLabel(tab.owner, 'chat'), element: guide.elementSummary, guideId: guide.id };
  }
  return { outcome: 'owner_finished', owner: ownerLabel(tab.owner, runtime?.kind), element: guide.elementSummary, guideId: guide.id };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function tabAction(pathname) {
  const match = /^\/api\/browser-agent\/tabs\/([^/]+)\/(frame|unassign|reassign|close|guide\/select|guide|control|navigate|back|forward|reload|input)$/u.exec(pathname);
  return match ? { tabId: decodeURIComponent(match[1]), action: match[2] } : null;
}

export function createAgentBrowserMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/browser-agent')) return next();
    try {
      const now = Date.now();
      for (const [key, value] of targetTokens) {
        if (value.expiresAt < now) targetTokens.delete(key);
      }
      for (const [key, value] of guideSelectionTokens) {
        if (value.expiresAt < now) guideSelectionTokens.delete(key);
      }
      while (targetTokens.size > 512) targetTokens.delete(targetTokens.keys().next().value);
      while (guideSelectionTokens.size > 512) guideSelectionTokens.delete(guideSelectionTokens.keys().next().value);
      pruneRuntimeTombstones();
      if (url.pathname === '/api/browser-agent/tabs' && req.method === 'GET') {
        return sendJson(res, 200, { tabs: getService().listTabs().map(tabWithOwnerLabel) });
      }
      if (url.pathname === '/api/browser-agent/events' && req.method === 'GET') {
        const browser = getService();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Connection', 'keep-alive');
        const changed = () => res.write(`data: ${JSON.stringify({ type: 'tabs-changed' })}\n\n`);
        browser.on('tabs-changed', changed);
        res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
        req.on('close', () => {
          browser.off('tabs-changed', changed);
        });
        return;
      }
      if (url.pathname === '/api/browser-agent/targets' && req.method === 'GET') {
        const activeChatIds = new Set([...runtimes.values()].filter((runtime) => runtime.ended !== true && runtime.kind === 'chat').map((runtime) => runtime.owner.chatId));
        const activeTargets = [...runtimes.values()]
          .filter((runtime) => runtime.ended !== true)
          .map((runtime) => stableTarget(runtime.owner, runtime.kind, 'active', ownerLabel(runtime.owner, runtime.kind)));
        const idleTargets = readChatSummaries()
          .filter((chat) => typeof chat.id === 'string' && chat.id && !activeChatIds.has(chat.id) && !chat.boardTaskId)
          .map((chat) => {
            const owner = { chatId: chat.id, runId: 'idle', agentId: 'main' };
            return stableTarget(owner, 'chat', 'idle', typeof chat.name === 'string' && chat.name.trim() ? chat.name.trim() : `Chat ${chat.id}`);
          });
        return sendJson(res, 200, { targets: [...activeTargets, ...idleTargets] });
      }
      if (url.pathname === '/api/browser-agent/runtime/register' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const handle = await registerAgentBrowserRuntime(body.runtimeOwner, { kind: 'chat' });
        return sendJson(res, 200, { runtimeToken: handle.token, owner: handle.owner });
      }
      const runtimeMatch = /^\/api\/browser-agent\/runtime\/([^/]+)\/(events|heartbeat|ack|unregister)$/u.exec(url.pathname);
      if (runtimeMatch) {
        const runtime = runtimeTokens.get(decodeURIComponent(runtimeMatch[1]));
        if (!runtime) return sendJson(res, 404, { error: 'Unknown browser runtime token' });
        const action = runtimeMatch[2];
        if (action === 'events' && req.method === 'GET') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Connection', 'keep-alive');
          try { runtime.connection?.end(); } catch {}
          runtime.connection = res;
          runtime.lastHeartbeatAt = Date.now();
          for (const guide of runtime.guides) writeRuntimeEvent(res, guide);
          req.on('close', () => {
            if (runtime.connection === res) runtime.connection = null;
          });
          return;
        }
        if (action === 'heartbeat' && req.method === 'POST') {
          runtime.lastHeartbeatAt = Date.now();
          return sendJson(res, 200, { ok: true });
        }
        if (action === 'ack' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const id = requiredId(body.guideId, 'guideId');
          runtime.acked.add(id);
          runtime.guides = runtime.guides.filter((row) => row.id !== id);
          return sendJson(res, 200, { ok: true });
        }
        if (action === 'unregister' && req.method === 'POST') {
          runtime.handle.close();
          return sendJson(res, 200, { ok: true });
        }
      }
      const action = tabAction(url.pathname);
      if (action) {
        const browser = getService();
        if (action.action === 'frame' && req.method === 'GET') {
          await refreshTrustedTabPolicy(browser, action.tabId);
          const frame = await browser.captureFrame(action.tabId);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Minnow-Agent-Browser-Viewport-Width', String(frame.width));
          res.setHeader('X-Minnow-Agent-Browser-Viewport-Height', String(frame.height));
          res.setHeader('X-Minnow-Agent-Browser-Frame-Revision', String(frame.revision));
          res.end(Buffer.from(frame.pngBase64, 'base64'));
          return;
        }
        const body = await readJsonBody(req);
        if (action.action === 'unassign' && req.method === 'POST') {
          const out = await browser.unassignTab(action.tabId);
          deleteLeasesForTab(action.tabId);
          return sendJson(res, 200, out);
        }
        if (action.action === 'reassign' && req.method === 'POST') {
          const target = targetTokens.get(requiredId(body.targetId, 'targetId'));
          if (!target || target.expiresAt < Date.now()) return sendJson(res, 400, { error: 'Target selection expired' });
          if (target.status === 'active') {
            const runtime = runtimeFor(target.owner);
            if (!runtime || runtime.ended) return sendJson(res, 409, { error: 'Target run finished; refresh the target list' });
          } else if ([...runtimes.values()].some((runtime) => runtime.kind === 'chat' && !runtime.ended && runtime.owner.chatId === target.owner.chatId)) {
            return sendJson(res, 409, { error: 'That chat started a new turn; refresh the target list' });
          }
          const out = await browser.reassignTab(action.tabId, target.owner);
          deleteLeasesForTab(action.tabId);
          if (out.lease) leases.set(leaseKey(target.owner, action.tabId), out.lease);
          return sendJson(res, 200, out);
        }
        if (action.action === 'close' && req.method === 'POST') {
          await browser.closeTab(action.tabId);
          deleteLeasesForTab(action.tabId);
          return sendJson(res, 200, { ok: true });
        }
        if (action.action === 'guide/select' && req.method === 'POST') return sendJson(res, 200, await selectGuideTarget(action.tabId, body));
        if (action.action === 'guide' && req.method === 'POST') return sendJson(res, 200, await deliverGuide(action.tabId, body));
        if (action.action === 'control' && req.method === 'POST') {
          await refreshTrustedTabPolicy(browser, action.tabId);
          return sendJson(res, 200, await browser.setControlMode(action.tabId, body.mode));
        }
        if (action.action === 'navigate' && req.method === 'POST') {
          const targetUrl = requiredId(body.url, 'url');
          await refreshTrustedTabPolicy(browser, action.tabId, targetUrl);
          const out = await browser.navigateOperator(action.tabId, targetUrl);
          consumeEphemeralNavigation(originFromUrl(targetUrl));
          return sendJson(res, 200, out);
        }
        if (action.action === 'back' && req.method === 'POST') {
          await refreshTrustedTabPolicy(browser, action.tabId);
          return sendJson(res, 200, await browser.historyOperator(action.tabId, 'back'));
        }
        if (action.action === 'forward' && req.method === 'POST') {
          await refreshTrustedTabPolicy(browser, action.tabId);
          return sendJson(res, 200, await browser.historyOperator(action.tabId, 'forward'));
        }
        if (action.action === 'reload' && req.method === 'POST') {
          await refreshTrustedTabPolicy(browser, action.tabId);
          return sendJson(res, 200, await browser.historyOperator(action.tabId, 'reload'));
        }
        if (action.action === 'input' && req.method === 'POST') {
          await refreshTrustedTabPolicy(browser, action.tabId);
          const modifierFlags = body.modifiers && typeof body.modifiers === 'object'
            ? (body.modifiers.alt ? 1 : 0) | (body.modifiers.ctrl ? 2 : 0) | (body.modifiers.meta ? 4 : 0) | (body.modifiers.shift ? 8 : 0)
            : Number(body.modifiers ?? 0);
          const buttonNames = ['left', 'middle', 'right'];
          const event = {
            ...body,
            kind: body.kind ?? body.type,
            action: body.action ?? body.phase,
            button: typeof body.button === 'number' ? (buttonNames[body.button] ?? 'none') : body.button,
            modifiers: modifierFlags,
          };
          if (event.kind === 'wheel') {
            event.x = Number.isFinite(Number(event.x)) ? Number(event.x) : 0;
            event.y = Number.isFinite(Number(event.y)) ? Number(event.y) : 0;
          }
          return sendJson(res, 200, await browser.dispatchControlInput(action.tabId, event));
        }
      }
      if (url.pathname === '/api/browser-agent/clear' && req.method === 'POST') {
        await getService().clearTabs();
        leases.clear();
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/browser-agent/shutdown' && req.method === 'POST') {
        await shutdownAgentBrowserService();
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(res, 400, { error: message });
    }
  };
}

export async function shutdownAgentBrowserService() {
  if (service) await service.close();
  service = null;
  leases.clear();
  for (const runtime of runtimes.values()) runtime.handle.close();
  runtimes.clear();
  runtimeTokens.clear();
  pendingGuides.clear();
  targetTokens.clear();
  assignmentTargetIds.clear();
  guideSelectionTokens.clear();
}

export function resetAgentBrowserRuntimeForTests() {
  leases.clear();
  runtimes.clear();
  runtimeTokens.clear();
  pendingGuides.clear();
  targetTokens.clear();
  assignmentTargetIds.clear();
  guideSelectionTokens.clear();
  service = null;
}
