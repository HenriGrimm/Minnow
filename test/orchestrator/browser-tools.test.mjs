
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { resetBrowserConfigCache, loadBrowserConfig } from '../../server/cdp/browser-config.js';
import { isNavigationAllowed } from '../../server/cdp/allowlist.js';
import { executeInProcessTool } from '../../server/runner/node.js';
import {
  BOARD_BUILDER_TOOL_IDS,
  BOARD_VERIFIER_TOOL_IDS,
  BOARD_WRITE_TOOL_IDS,
  BROWSER_TOOL_IDS,
  DEFAULT_HEADLESS_TOOL_IDS,
  FINAL_TESTER_TOOL_IDS,
  RENDERER_ONLY_TOOL_IDS,
  browserToolsIn,
  dispatchToolIdsForRole,
  headlessToolIdsForRole,
  rendererOnlyToolsIn,
} from '../../server/runner/tool-set.js';
import {
  BROWSER_DRIVER_TOOL_DEFINITIONS,
  BROWSER_DRIVER_TOOL_IDS,
} from '../../server/tools/browser-driver-tool-defs.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../../server/tools/output-cap.js';
import {
  BROWSER_BLOCKED_PREFIX,
  BROWSER_UNAVAILABLE_PREFIX,
  browserToolSessionKeys,
  closeAllBrowserToolSessions,
  normalizeConsoleEntries,
  normalizeNetworkEntries,
  setBrowserToolLauncher,
} from '../../server/tools/browser-driver-tools.js';

/** @type {string} */
let homeDir;
/** @type {string} */
let cwd;
/** @type {string | undefined} */
let previousHome;

before(async () => {
  previousHome = process.env.MINNOW_HOME;
  homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mn-btools-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  resetBrowserConfigCache();
  cwd = path.join(homeDir, 'chats');
  await fsp.mkdir(cwd, { recursive: true });
});

after(async () => {
  setBrowserToolLauncher(null);
  await closeAllBrowserToolSessions();
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetBrowserConfigCache();
  await fsp.rm(homeDir, { recursive: true, force: true, maxRetries: 5 });
});

afterEach(async () => {
  await closeAllBrowserToolSessions();
  setBrowserToolLauncher(null);
});

/**
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @param {{ allowedToolNames?: readonly string[] }} [opts]
 * @returns {Promise<string>}
 */
async function callTool(name, args = {}, opts = {}) {
  const result = await executeInProcessTool(name, args, {
    cwd,
    ...(opts.allowedToolNames ? { allowedToolNames: [...opts.allowedToolNames] } : {}),
  });
  return result.content;
}

/**
 * @param {Partial<Record<string, unknown>>} [overrides]
 */
function fakeSession(overrides = {}) {
/** @type {Record<string, unknown>} */
  const session = {
    client: {
      on() {},
      off() {},
      async send() {
        return {};
      },
    },
    alive: true,
    currentUrl: null,
    lastSnapshot: null,
    status() {
      return {
        alive: session.alive,
        pid: 1,
        port: 1,
        profileDir: '',
        executablePath: '',
        browserVersion: 'fake/1',
        endedReason: session.alive ? null : 'user',
        endedDetail: null,
        currentUrl: session.currentUrl,
      };
    },
    async navigate(url) {
      session.currentUrl = url;
      return { outcome: 'loaded', url, title: 'Fake' };
    },
    async text() {
      return 'fake text';
    },
    async html() {
      return '<html></html>';
    },
    async snapshot() {
      const snap = { nodes: [], byUid: new Map(), text: '[1] RootWebArea "Fake"' };
      session.lastSnapshot = snap;
      return snap;
    },
    consoleMessages() {
      return [];
    },
    async screenshot() {
      return { ok: false, error: 'no browser' };
    },
    async close() {
      session.alive = false;
      return session.status();
    },
  };
  return Object.assign(session, overrides);
}

/** @param {Record<string, unknown>} session */
function launcherFor(session) {
  return async () => ({ ok: true, session, capability: { available: true } });
}

// ── Final-Tester-only gating ─────────────────────────────────────────────────

describe('Final-Tester-only gating', () => {
  test('no role — the Final Tester included — is shown a browser tool', () => {
    for (const role of ['builder', 'tester', 'merge', 'final', 'sub-agent', 'anything-else']) {
      assert.deepEqual(
        browserToolsIn(headlessToolIdsForRole(role)),
        [],
        `role ${role} must not be able to drive a browser`,
      );
    }
  });

  test('board roles are scoped; anything else keeps the full headless set', () => {
    assert.deepEqual([...headlessToolIdsForRole('builder')], [...BOARD_BUILDER_TOOL_IDS]);
    for (const role of ['tester', 'merge', 'final']) {
      assert.deepEqual([...headlessToolIdsForRole(role)], [...BOARD_VERIFIER_TOOL_IDS]);
    }
    for (const role of ['sub-agent', 'anything-else']) {
      assert.deepEqual([...headlessToolIdsForRole(role)], [...DEFAULT_HEADLESS_TOOL_IDS]);
    }
  });

  test('verifying roles hold no tool that writes the checkout', () => {
    const verifier = new Set(BOARD_VERIFIER_TOOL_IDS);
    for (const id of BOARD_WRITE_TOOL_IDS) {
      assert.equal(verifier.has(id), false, `${id} must not reach a verifying role`);
    }
  });

  test('the browser rung dispatches what no Final Tester model can see', () => {
    assert.deepEqual(browserToolsIn(FINAL_TESTER_TOOL_IDS), [...BROWSER_TOOL_IDS]);
    assert.deepEqual([...dispatchToolIdsForRole('final')], [...FINAL_TESTER_TOOL_IDS]);
    assert.deepEqual(browserToolsIn(headlessToolIdsForRole('final')), []);
    assert.deepEqual(rendererOnlyToolsIn(FINAL_TESTER_TOOL_IDS), []);
  });

  test('the two copies of the id list agree', () => {
    assert.deepEqual([...BROWSER_TOOL_IDS], [...BROWSER_DRIVER_TOOL_IDS]);
  });

  test('the driver names never collide with the renderer browser tools', () => {
    const renderer = new Set(RENDERER_ONLY_TOOL_IDS);
    for (const id of BROWSER_DRIVER_TOOL_IDS) {
      assert.equal(renderer.has(id), false, `${id} collides with a renderer-only tool`);
    }
  });

  test('every id has a full schema — these tools have no renderer catalog entry', () => {
    const named = BROWSER_DRIVER_TOOL_DEFINITIONS.map((d) => d.function.name);
    assert.deepEqual(named, [...BROWSER_DRIVER_TOOL_IDS]);
    for (const def of BROWSER_DRIVER_TOOL_DEFINITIONS) {
      assert.equal(def.function.parameters.type, 'object');
      assert.notEqual(def.function.description, def.function.name, 'description must be real');
    }
  });

  test('a Builder-scoped dispatch refuses a browser tool by name', async () => {
    const content = await callTool(
      'browser_drive_navigate',
      { url: 'http://localhost:1/' },
      { allowedToolNames: DEFAULT_HEADLESS_TOOL_IDS },
    );
    assert.match(content, /is not in the allowed set/);
    assert.deepEqual(browserToolSessionKeys(), [], 'a refused call must not launch a browser');
  });
});

// ── standard tool dispatch ───────────────────────────────────────────────────

describe('standard tool dispatch', () => {
  test('every browser tool is dispatchable, not "Not implemented"', async () => {
    for (const name of BROWSER_DRIVER_TOOL_IDS) {
      const content = await callTool(name, {}, { allowedToolNames: FINAL_TESTER_TOOL_IDS });
      assert.equal(
        content.startsWith(`Not implemented: ${name}`),
        false,
        `${name} is missing from the server registry`,
      );
    }
  });

  test('a read before any navigate answers, rather than launching a browser', async () => {
    const content = await callTool('browser_drive_read_page', {});
    assert.match(content, /no browser is open/);
    assert.deepEqual(browserToolSessionKeys(), []);
  });
});

// ── allowlist ────────────────────────────────────────────────────────────────

describe('allowlist', () => {
  test('a disallowed origin is blocked, with the same verdict as the renderer path', async () => {
    setBrowserToolLauncher(launcherFor(fakeSession()));
    const config = await loadBrowserConfig();

    const cases = [
      'http://localhost:5173/',
      'http://127.0.0.1:8080/app',
      'https://evil.example.com/',
      'http://10.0.0.5:3000/',
    ];
    for (const url of cases) {
      const content = await callTool('browser_drive_navigate', { url });
      const blocked = content.startsWith(BROWSER_BLOCKED_PREFIX);
      assert.equal(
        blocked,
        !isNavigationAllowed(url, config.allowedOriginPatterns),
        `verdict for ${url} diverged from the renderer allowlist: ${content}`,
      );
      await closeAllBrowserToolSessions();
    }
  });

  test('a blocked navigation never starts a browser', async () => {
    let launches = 0;
    setBrowserToolLauncher(async () => {
      launches += 1;
      return { ok: true, session: fakeSession(), capability: { available: true } };
    });
    const content = await callTool('browser_drive_navigate', { url: 'https://evil.example.com/' });
    assert.ok(content.startsWith(BROWSER_BLOCKED_PREFIX), content);
    assert.equal(launches, 0);
  });

  test('an absent browser degrades to a readable skip, not a failure', async () => {
    setBrowserToolLauncher(async () => ({
      ok: false,
      reason: 'no-chromium-browser',
      detail: 'searched 4 locations',
    }));
    const content = await callTool('browser_drive_navigate', { url: 'http://localhost:5173/' });
    assert.ok(content.startsWith(BROWSER_UNAVAILABLE_PREFIX), content);
    assert.match(content, /skipped, not failed/);
  });
});

// ── output caps ──────────────────────────────────────────────────────────────

describe('output caps', () => {
  test('a large DOM read is truncated and says so', async () => {
    const huge = `<html><body>${'x'.repeat(DEFAULT_MAX_OUTPUT_CHARS * 2)}</body></html>`;
    setBrowserToolLauncher(launcherFor(fakeSession({ async html() { return huge; } })));
    await callTool('browser_drive_navigate', { url: 'http://localhost:5173/' });

    const content = await callTool('browser_drive_read_page', { mode: 'dom' });
    assert.match(content, /\[truncated — \d+ of \d+ chars;/);
    assert.ok(
      content.length < DEFAULT_MAX_OUTPUT_CHARS * 1.05,
      `expected a capped read, got ${content.length}`,
    );
    assert.match(content, /UNTRUSTED_SOURCE_DATA/);
  });

  test('max_chars can narrow the read but not widen it past the shared cap', async () => {
    const huge = 'y'.repeat(200_000);
    setBrowserToolLauncher(launcherFor(fakeSession({ async text() { return huge; } })));
    await callTool('browser_drive_navigate', { url: 'http://localhost:5173/' });

    const narrow = await callTool('browser_drive_read_page', { mode: 'text', max_chars: 800 });
    const wide = await callTool('browser_drive_read_page', { mode: 'text', max_chars: 10_000_000 });
    assert.ok(narrow.length < 2_000, `narrow read was ${narrow.length}`);
    assert.ok(wide.length < 40_000, `max_chars must not raise the shared cap: ${wide.length}`);
    assert.match(narrow, /truncated/);
  });
});

// ── per-call timeouts ────────────────────────────────────────────────────────

describe('per-call timeouts', () => {
  test('a hung navigation fails one tool call and the attempt continues', async () => {
    setBrowserToolLauncher(
      launcherFor(
        fakeSession({
          navigate() {
            return new Promise(() => {});
          },
        }),
      ),
    );

    const startedAt = Date.now();
    const content = await callTool('browser_drive_navigate', {
      url: 'http://localhost:5173/',
      timeout_ms: 400,
    });
    const elapsed = Date.now() - startedAt;

    assert.match(content, /^Error: browser_drive_navigate timed out after 400ms/);
    assert.match(content, /this call failed, the attempt did not/);
    assert.ok(elapsed < 10_000, `the call must end on its own deadline, took ${elapsed}ms`);

    const after = await callTool('browser_drive_read_console', {});
    assert.match(after, /console: \(no entries\)/);
  });

  test('a hung read fails alone and leaves the session usable', async () => {
    setBrowserToolLauncher(
      launcherFor(
        fakeSession({
          html() {
            return new Promise(() => {});
          },
        }),
      ),
    );
    await callTool('browser_drive_navigate', { url: 'http://localhost:5173/' });

    const hung = await callTool('browser_drive_read_page', { mode: 'dom', timeout_ms: 300 });
    assert.match(hung, /^Error: browser_drive_read_page timed out after 300ms/);

    const ok = await callTool('browser_drive_read_page', { mode: 'text' });
    assert.match(ok, /fake text/);
  });

  test('a rejecting driver call becomes a tool error, never an unhandled rejection', async () => {
    setBrowserToolLauncher(
      launcherFor(
        fakeSession({
          async snapshot() {
            throw new Error('accessibility tree unavailable');
          },
        }),
      ),
    );
    await callTool('browser_drive_navigate', { url: 'http://localhost:5173/' });
    const content = await callTool('browser_drive_read_page', { mode: 'a11y' });
    assert.match(content, /^Error: accessibility tree unavailable/);
  });
});

// ── deterministic normalizers ────────────────────────────────────────────────

describe('deterministic normalizers', () => {
  test('console lines drop the timestamp that would make two reads differ', () => {
    const first = normalizeConsoleEntries([
      { level: 'error', text: 'boom', at: 1 },
      { level: 'log', text: 'hello\nworld', at: 2 },
    ]);
    const second = normalizeConsoleEntries([
      { level: 'error', text: 'boom', at: 999_999 },
      { level: 'log', text: 'hello\nworld', at: 1_000_000 },
    ]);
    assert.deepEqual(first, second);
    assert.deepEqual(first, ['[error] boom', '[log] hello world']);
  });

  test('console filters by level and keeps the tail on limit', () => {
    const entries = [
      { level: 'log', text: 'a', at: 1 },
      { level: 'error', text: 'b', at: 2 },
      { level: 'log', text: 'c', at: 3 },
    ];
    assert.deepEqual(normalizeConsoleEntries(entries, { level: 'error' }), ['[error] b']);
    assert.deepEqual(normalizeConsoleEntries(entries, { limit: 2 }), ['[error] b', '[log] c']);
  });

  test('network lines are order-independent — arrival order cannot leak in', () => {
    const rows = [
      { url: 'http://x/b', method: 'GET', status: 200, failed: false, errorText: '' },
      { url: 'http://x/a', method: 'POST', status: 404, failed: false, errorText: '' },
      { url: 'http://x/c', method: 'GET', status: null, failed: true, errorText: 'net::ERR' },
    ];
    const forward = normalizeNetworkEntries(rows);
    const reversed = normalizeNetworkEntries([...rows].reverse());
    const shuffled = normalizeNetworkEntries([rows[1], rows[2], rows[0]]);
    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward, shuffled);
    assert.deepEqual(forward, [
      'POST 404 http://x/a',
      'GET 200 http://x/b',
      'GET FAILED(net::ERR) http://x/c',
    ]);
  });

  test('network failed_only keeps failures and 4xx/5xx', () => {
    const rows = [
      { url: 'http://x/ok', method: 'GET', status: 200, failed: false, errorText: '' },
      { url: 'http://x/gone', method: 'GET', status: 404, failed: false, errorText: '' },
      { url: 'http://x/dead', method: 'GET', status: null, failed: true, errorText: 'ERR' },
    ];
    assert.deepEqual(normalizeNetworkEntries(rows, { failedOnly: true }), [
      'GET FAILED(ERR) http://x/dead',
      'GET 404 http://x/gone',
    ]);
  });

  test('repeated reads of an unchanged fake page are byte-identical', async () => {
    setBrowserToolLauncher(launcherFor(fakeSession()));
    await callTool('browser_drive_navigate', { url: 'http://localhost:5173/' });
    for (const mode of ['a11y', 'text', 'dom']) {
      const first = await callTool('browser_drive_read_page', { mode });
      const second = await callTool('browser_drive_read_page', { mode });
      assert.equal(first, second, `mode ${mode} was not deterministic`);
    }
  });
});

// ── uid-addressed interaction ────────────────────────────────────────────────

describe('uid-addressed interaction', () => {
  test('click before a snapshot is refused rather than guessed at', async () => {
    setBrowserToolLauncher(launcherFor(fakeSession()));
    await callTool('browser_drive_navigate', { url: 'http://localhost:5173/' });
    const content = await callTool('browser_drive_click', { uid: 3 });
    assert.match(content, /^Error: no current page snapshot/);
  });

  test('a uid absent from the current snapshot is refused', async () => {
    setBrowserToolLauncher(launcherFor(fakeSession()));
    await callTool('browser_drive_navigate', { url: 'http://localhost:5173/' });
    await callTool('browser_drive_read_page', { mode: 'a11y' });
    const content = await callTool('browser_drive_click', { uid: 99 });
    assert.match(content, /^Error: uid 99 is not in the current snapshot/);
  });
});
