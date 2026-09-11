/**
 * P5-A — Server-side browser driver, unit surface (MIN-719).
 *
 * Nothing in this file launches a browser. Discovery order, option
 * normalization, argv construction, the accessibility walk, the allowlist
 * verdict, and the absent-browser capability report are all pure or
 * filesystem-only, and they are the parts that must keep working on a machine
 * with no Chromium at all.
 *
 * The live counterpart is `browser-driver-live.test.mjs`.
 */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { resetBrowserConfigCache } from '../../server/cdp/browser-config.js';
import {
  BROWSER_PATH_ENV,
  CdpClient,
  CdpError,
  DEFAULT_HARD_TIMEOUT_MS,
  browserCandidates,
  browserProfileRoot,
  buildLaunchArgs,
  buildSnapshot,
  capText,
  createProfileDir,
  discoverBrowser,
  familyFromPath,
  isPidAlive,
  launchBrowser,
  normalizeLaunchOptions,
  probeBrowserCapability,
  removeProfileDir,
  renderTree,
  sweepStaleProfiles,
} from '../../server/browser-driver/index.js';

/** @type {string} */
let homeDir;
/** @type {string | undefined} */
let previousHome;

before(async () => {
  previousHome = process.env.MINNOW_HOME;
  homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mn-driver-unit-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  resetBrowserConfigCache();
});

after(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetBrowserConfigCache();
  await fsp.rm(homeDir, { recursive: true, force: true, maxRetries: 5 });
});

// ── discovery ────────────────────────────────────────────────────────────────

describe('discovery', () => {
  test('win32 candidates prefer Chrome, then Edge, then Brave', () => {
    const candidates = browserCandidates('win32', {
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    });
    const families = candidates.map((c) => c.family);
    assert.equal(families[0], 'chrome');
    assert.ok(families.indexOf('chrome') < families.indexOf('edge'), 'chrome before edge');
    assert.ok(families.indexOf('edge') < families.indexOf('brave'), 'edge before brave');
    assert.ok(
      candidates.some(
        (c) =>
          c.executablePath ===
          path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ),
      'expected the Program Files Chrome path',
    );
  });

  test('candidates come back empty when the environment names no roots', () => {
    assert.deepEqual(browserCandidates('win32', {}), []);
  });

  test('darwin and linux candidates are absolute paths', () => {
    for (const platform of ['darwin', 'linux']) {
      const candidates = browserCandidates(platform, { HOME: '/home/u' });
      assert.ok(candidates.length > 0, `${platform} should have candidates`);
      for (const c of candidates) {
        assert.ok(path.isAbsolute(c.executablePath), `${c.executablePath} should be absolute`);
      }
    }
  });

  test('familyFromPath recognizes the Chromium forks', () => {
    assert.equal(familyFromPath('C:\\x\\msedge.exe'), 'edge');
    assert.equal(familyFromPath('/usr/bin/brave-browser'), 'brave');
    assert.equal(familyFromPath('/usr/bin/chromium'), 'chromium');
    assert.equal(familyFromPath('C:\\x\\Chrome\\chrome.exe'), 'chrome');
  });

  test('darwin candidates cover every Chrome, Edge, and Brave channel in both app folders', () => {
    const candidates = browserCandidates('darwin', { HOME: '/Users/u' });
    const paths = candidates.map((c) => c.executablePath.replaceAll('\\', '/'));
    assert.equal(paths[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    for (const name of ['Google Chrome Beta', 'Microsoft Edge Dev', 'Brave Browser Nightly', 'Chromium']) {
      assert.ok(paths.includes(`/Applications/${name}.app/Contents/MacOS/${name}`), `missing ${name}`);
      assert.ok(paths.includes(`/Users/u/Applications/${name}.app/Contents/MacOS/${name}`), `missing ~/Applications ${name}`);
    }
  });

  test('darwin falls back to Spotlight for browsers outside the app folders', async () => {
    const app = path.join(homeDir, 'Elsewhere', 'Renamed Chrome.app');
    const executable = path.join(app, 'Contents', 'MacOS', 'Google Chrome');
    await fsp.mkdir(path.dirname(executable), { recursive: true });
    await fsp.writeFile(executable, 'not really a browser', 'utf8');
    const capability = await discoverBrowser({
      platform: 'darwin',
      env: { HOME: path.join(homeDir, 'no-such-home') },
      spotlight: async () => [
        { executablePath: path.join(app, 'Contents', 'MacOS', 'Microsoft Edge'), family: 'edge' },
        { executablePath: executable, family: 'chrome' },
      ],
    });
    assert.equal(capability.available, true);
    assert.equal(capability.executablePath, executable);
    assert.equal(capability.family, 'chrome');
  });

  test('an absent browser is a report, not a throw', async () => {
    const capability = await discoverBrowser({ platform: 'win32', env: {} });
    assert.equal(capability.available, false);
    assert.equal(capability.reason, 'no-chromium-browser');
    assert.match(capability.detail, /Chrome, Edge, Brave, or Chromium/);
    assert.ok(Array.isArray(capability.searched));
  });

  test('an executablePath that does not exist reports, not throws', async () => {
    const missing = path.join(os.tmpdir(), 'definitely-not-a-browser-xyz.exe');
    const capability = await discoverBrowser({ executablePath: missing });
    assert.equal(capability.available, false);
    assert.equal(capability.reason, 'env-path-missing');
    assert.deepEqual(capability.searched, [missing]);
  });

  test(`${BROWSER_PATH_ENV} overrides the probe`, async () => {
    const fake = path.join(homeDir, 'fake-browser.exe');
    await fsp.writeFile(fake, 'not really a browser', 'utf8');
    const capability = await discoverBrowser({
      platform: 'win32',
      env: { [BROWSER_PATH_ENV]: fake },
    });
    assert.equal(capability.available, true);
    assert.equal(capability.executablePath, fake);
    assert.equal(capability.source, 'env');
  });

  test('probeBrowserCapability reports a disabled setting without throwing', async () => {
    const configPath = path.join(homeDir, 'config.json');
    await fsp.writeFile(configPath, JSON.stringify({ browser: { enabled: false } }), 'utf8');
    resetBrowserConfigCache();
    try {
      const capability = await probeBrowserCapability();
      assert.equal(capability.available, false);
      assert.equal(capability.reason, 'disabled-in-settings');

      const launched = await launchBrowser();
      assert.equal(launched.ok, false);
      assert.equal(launched.reason, 'disabled-in-settings');
    } finally {
      await fsp.rm(configPath, { force: true });
      resetBrowserConfigCache();
    }
  });
});

// ── launch options ───────────────────────────────────────────────────────────

describe('launch options', () => {
  test('defaults are applied and nonsense values fall back', () => {
    const options = normalizeLaunchOptions({ hardTimeoutMs: -5, commandTimeoutMs: 'nope' });
    assert.equal(options.hardTimeoutMs, DEFAULT_HARD_TIMEOUT_MS);
    assert.ok(options.commandTimeoutMs > 0);
    assert.equal(options.headless, true);
    assert.deepEqual(options.extraArgs, []);
  });

  test('headless is opt-out, not opt-in', () => {
    assert.equal(normalizeLaunchOptions({}).headless, true);
    assert.equal(normalizeLaunchOptions({ headless: false }).headless, false);
  });

  test('argv pins an ephemeral debug port and an isolated profile', () => {
    const options = normalizeLaunchOptions({});
    const args = buildLaunchArgs({ profileDir: 'C:\\tmp\\p1', options });
    assert.ok(args.includes('--remote-debugging-port=0'));
    assert.ok(args.includes('--user-data-dir=C:\\tmp\\p1'));
    assert.ok(args.includes('--headless=new'));
    assert.ok(args.includes('--no-first-run'));
    assert.ok(args.includes('--disable-extensions'));
    assert.ok(args.includes('--disable-sync'));
    assert.equal(args.at(-1), 'about:blank');
  });

  test('headed launches omit the headless flag and keep extra args', () => {
    const options = normalizeLaunchOptions({ headless: false, extraArgs: ['--mute-audio'] });
    const args = buildLaunchArgs({ profileDir: '/tmp/p2', options });
    assert.ok(!args.includes('--headless=new'));
    assert.ok(args.includes('--mute-audio'));
  });

  test('capText truncates and says so', () => {
    assert.equal(capText('abc', 10), 'abc');
    const capped = capText('x'.repeat(50), 10);
    assert.ok(capped.startsWith('x'.repeat(10)));
    assert.match(capped, /truncated 40 chars/);
  });
});

// ── profile directories ──────────────────────────────────────────────────────

describe('profile directories', () => {
  test('a profile is minted under the Minnow home and removed again', async () => {
    const dir = await createProfileDir('board-1');
    assert.ok(dir.startsWith(browserProfileRoot()), 'profile must live under the driver root');
    assert.ok(path.basename(dir).startsWith('board-1-'));
    await fsp.writeFile(path.join(dir, 'Cookies'), 'x', 'utf8');

    const removed = await removeProfileDir(dir);
    assert.equal(removed.removed, true);
    await assert.rejects(() => fsp.access(dir));
  });

  test('two profiles never collide', async () => {
    const [a, b] = await Promise.all([createProfileDir('run'), createProfileDir('run')]);
    assert.notEqual(a, b);
    await Promise.all([removeProfileDir(a), removeProfileDir(b)]);
  });

  test('the profile root itself is not removable', async () => {
    const result = await removeProfileDir(browserProfileRoot());
    assert.equal(result.removed, false);
    assert.match(String(result.error), /refusing/);
  });

  test('sweepStaleProfiles removes only what a crashed host left behind', async () => {
    const stale = await createProfileDir('stale');
    const fresh = await createProfileDir('fresh');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fsp.utimes(stale, old, old);

    const swept = await sweepStaleProfiles(24 * 60 * 60 * 1000);
    assert.deepEqual(swept.removed, [stale]);
    assert.deepEqual(swept.failed, []);
    await assert.rejects(() => fsp.access(stale));
    await fsp.access(fresh); // untouched

    await removeProfileDir(fresh);
  });
});

// ── accessibility snapshot ───────────────────────────────────────────────────

describe('accessibility snapshot', () => {
  test('an empty tree renders as (empty page)', () => {
    const snap = buildSnapshot(undefined);
    assert.equal(snap.text, '(empty page)');
    assert.equal(snap.nodes.length, 0);
  });

  test('ignored wrapper nodes hoist their children instead of pruning them', () => {
    const snap = buildSnapshot([
      {
        nodeId: '1',
        role: { value: 'RootWebArea' },
        name: { value: 'Doc' },
        childIds: ['2'],
        backendDOMNodeId: 1,
      },
      { nodeId: '2', ignored: true, role: { value: 'none' }, childIds: ['3', '4'] },
      {
        nodeId: '3',
        role: { value: 'heading' },
        name: { value: 'Title' },
        backendDOMNodeId: 3,
      },
      {
        nodeId: '4',
        role: { value: 'button' },
        name: { value: 'Go' },
        backendDOMNodeId: 4,
      },
    ]);
    assert.match(snap.text, /RootWebArea "Doc"/);
    assert.match(snap.text, /heading "Title"/);
    assert.match(snap.text, /button "Go"/);

    const uids = [...snap.byUid.values()].map((n) => n.name);
    assert.ok(uids.includes('Go'), 'the button must be addressable by uid');
  });

  test('uids restart per snapshot so concurrent sessions cannot interleave', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: [] },
    ];
    assert.equal(buildSnapshot(nodes).nodes[0].uid, 1);
    assert.equal(buildSnapshot(nodes).nodes[0].uid, 1);
  });

  test('renderTree indents children', () => {
    const text = renderTree([
      { uid: 1, role: 'main', name: 'M', backendNodeId: 1, children: [
        { uid: 2, role: 'button', name: 'B', backendNodeId: 2 },
      ] },
    ]);
    assert.equal(text, '[1] main "M"\n [2] button "B"');
  });
});

// ── CDP client containment ───────────────────────────────────────────────────

describe('CDP client containment', () => {
  test('sending on an unconnected client rejects rather than hanging', async () => {
    const client = new CdpClient('ws://127.0.0.1:1/never');
    await assert.rejects(
      () => client.send('Page.enable'),
      (err) => err instanceof CdpError && err.code === 'closed',
    );
  });

  test('close() is idempotent and leaves the client rejecting', async () => {
    const client = new CdpClient('ws://127.0.0.1:1/never');
    client.close('first');
    client.close('second');
    await assert.rejects(() => client.send('Page.enable'), /second|first|not connected/);
  });

  test('off() removes a handler so repeated navigations do not leak listeners', () => {
    const client = new CdpClient('ws://127.0.0.1:1/never');
    let calls = 0;
    const handler = () => {
      calls += 1;
    };
    client.on('Page.loadEventFired', handler);
    assert.equal(client.eventHandlers.get('Page.loadEventFired')?.length, 1);
    client.off('Page.loadEventFired', handler);
    assert.equal(client.eventHandlers.has('Page.loadEventFired'), false);
    assert.equal(calls, 0);
  });
});

// ── absent-browser degradation ───────────────────────────────────────────────

describe('absent-browser degradation', () => {
  test('launchBrowser reports rather than throwing when the path is wrong', async () => {
    const launched = await launchBrowser({
      executablePath: path.join(os.tmpdir(), 'no-such-browser-abc.exe'),
    });
    assert.equal(launched.ok, false);
    assert.equal(launched.reason, 'env-path-missing');
    assert.match(launched.detail, /not a file/);
  });

  test('a failed launch leaves no profile directory behind', async () => {
    const before = await fsp.readdir(browserProfileRoot()).catch(() => []);
    await launchBrowser({ executablePath: path.join(os.tmpdir(), 'nope-xyz.exe') });
    const afterDirs = await fsp.readdir(browserProfileRoot()).catch(() => []);
    assert.deepEqual(afterDirs, before);
  });
});

// ── pid liveness ─────────────────────────────────────────────────────────────

describe('pid liveness', () => {
  test('this process is alive and pid 0 is not', () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-1), false);
  });
});
