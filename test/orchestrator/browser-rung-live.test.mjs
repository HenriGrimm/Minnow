
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { resetBrowserConfigCache } from '../../server/cdp/browser-config.js';
import { discoverBrowser, trackedBrowserPids } from '../../server/browser-driver/index.js';
import {
  browserToolSessionKeys,
  closeAllBrowserToolSessions,
  setBrowserToolLauncher,
} from '../../server/tools/browser-driver-tools.js';
import {
  canonicalBrowserVerdict,
  runBrowserRung,
} from '../../server/orchestrator/browser-rung.js';
import { parseRunInstructions, runFinalLadder } from '../../server/orchestrator/final-test.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';
import {
  getDevServerStatusById,
  resetDevServerManagerForTests,
  stopDevServerById,
} from '../../server/dev-server/manager.js';
import { writeDevServerSettings } from '../../server/dev-server/settings.js';
import { resetDevServerRegistryForTests } from '../../server/dev-server/registry.js';

/** @returns {Promise<number>} a port nothing is listening on right now */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

const SERVE_MJS = `import http from 'node:http';

const broken = process.env.MN_BROKEN === '1';
const page = (body) =>
  '<!doctype html><html><head><title>Fixture Dashboard</title></head><body>' + body + '</body></html>';

const server = http.createServer((req, res) => {
  const url = String(req.url ?? '/');
  if (url.startsWith('/health')) {
    res.setHeader('content-type', 'text/plain');
    res.end('ok');
    return;
  }
  if (url.startsWith('/dashboard')) {
    res.setHeader('content-type', 'text/html');
    res.end(
      page(
        broken
          ? '<h1>Dashboard</h1><p>Something went wrong.</p>'
          : '<h1>Dashboard</h1><p>Weekly totals</p>',
      ),
    );
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(page('<h1>Home</h1>'));
});

server.listen(Number(process.env.PORT), process.env.HOST || '127.0.0.1');
`;

/**
 * @param {string} headerText
 */
const planFor = (headerText) => `---
name: fixture-dashboard
overview: Ship the fixture dashboard.
todos:
  - id: T1
    content: "Wave 1: Render the header"
    status: pending
  - id: T2
    content: "Wave 1: Drop the old banner"
    status: pending
  - id: T3
    content: "Wave 1: Pure helper"
    status: pending
isProject: false
---

# Fixture Dashboard

## Wave Breakdown

### Wave 1 — Foundations

#### Task T1: Render the header
- **Build:** Render the header.
- **Test:** \`npm test\` passes.
- **Accept:** the /dashboard page shows "${headerText}"
- **Touches:** serve.mjs

#### Task T2: Drop the old banner
- **Build:** Delete the banner.
- **Test:** \`npm test\` passes.
- **Accept:** the /dashboard page no longer shows "Beta preview"
- **Touches:** serve.mjs

#### Task T3: Pure helper
- **Build:** Add a helper.
- **Test:** \`npm test\` passes.
- **Accept:** the helper rounds half to even
- **Touches:** serve.mjs

## Verification Checklist
- [ ] \`npm test\` passes
`;

const previousHome = process.env.MINNOW_HOME;
const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mn-p5c-live-'));
process.env.MINNOW_HOME = homeDir;
resetMinnowHomeCache();
resetBrowserConfigCache();

const workspace = path.join(homeDir, 'app');
await fsp.mkdir(workspace, { recursive: true });
await fsp.writeFile(path.join(workspace, 'serve.mjs'), SERVE_MJS, 'utf8');
await fsp.writeFile(
  path.join(workspace, 'package.json'),
  `${JSON.stringify(
    {
      name: 'p5c-live-fixture',
      private: true,
      type: 'module',
      scripts: {
        typecheck: 'node -e ""',
        lint: 'node -e ""',
        test: 'node -e ""',
        build: 'node -e ""',
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const appPort = await freePort();
await fsp.writeFile(
  path.join(workspace, 'startup.md'),
  `---
command: node serve.mjs
healthUrl: http://127.0.0.1:${appPort}/health
port: ${appPort}
---

# Fixture app
`,
  'utf8',
);

setWorkspaceRoot(workspace);
resetDevServerRegistryForTests();
resetDevServerManagerForTests();
await writeDevServerSettings(workspace, { port: appPort, network: 'local' });

const capability = await discoverBrowser();
/** @type {string | false} */
const skipReason = capability.available
  ? false
  : `no Chromium-family browser on this machine (${capability.reason})`;

after(async () => {
  setBrowserToolLauncher(null);
  await closeAllBrowserToolSessions();
  try {
    await stopDevServerById(workspace);
  } catch {
  }
  resetDevServerManagerForTests();
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetBrowserConfigCache();
  await Promise.race([
    fsp
      .rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch(() => {}),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      if (timer.unref) timer.unref();
    }),
  ]);
});

/**
 * @param {{ plan?: string, broken?: boolean }} [opts]
 */
async function runRung(opts = {}) {
  process.env.MN_BROKEN = opts.broken ? '1' : '0';
  return runBrowserRung({
    cwd: workspace,
    planMarkdown: opts.plan ?? planFor('Weekly totals'),
    settleMs: 100,
    assertTimeoutMs: 5_000,
    // Cold Windows shell startup competes with the full multi-process suite.
    // Keep the browser assertions unchanged and the readiness wait bounded.
    readyTimeoutMs: 60_000,
  });
}

describe('P5-C browser rung — live', { skip: skipReason, timeout: 240_000 }, () => {
  test('a working app passes, against a dev server this rung started and stopped', async () => {
    const result = await runRung();
    assert.equal(result.status, 'pass', JSON.stringify(result, null, 2));
    assert.equal(result.reason, null);
    assert.equal(result.port, appPort, 'the rung verified the pinned port, not a neighbour');
    assert.equal(
      result.assertions.every((a) => a.outcome === 'pass'),
      true,
      JSON.stringify(result.assertions, null, 2),
    );
    assert.deepEqual(
      result.notObservable.map((n) => n.taskId),
      ['T3'],
    );
    assert.ok(result.screenshots.length >= 1);

    assert.deepEqual(browserToolSessionKeys(), []);
    assert.deepEqual(trackedBrowserPids(), []);
    const status = await getDevServerStatusById(workspace);
    assert.notEqual(status.status, 'running');
  });

  test('a deliberately broken UI fails with a specific, actionable message', async () => {
    const result = await runRung({ broken: true });
    assert.equal(result.status, 'fail');
    const failed = result.assertions.find((a) => a.outcome === 'fail');
    assert.equal(failed?.taskId, 'T1');
    assert.equal(failed?.describe, 'page text contains "Weekly totals"');
    assert.match(failed?.url ?? '', /\/dashboard$/);
    assert.match(result.summary, /Weekly totals/);
    assert.equal(result.assertions.length, 2);
    assert.deepEqual(
      result.assertions.filter((a) => a.outcome === 'pass').map((a) => a.taskId),
      ['T2'],
    );
    assert.deepEqual(trackedBrowserPids(), []);
  });

  test('per-task Accept criteria drive the assertions — change one, the check changes', async () => {
    const result = await runRung({ plan: planFor('Monthly totals') });
    assert.equal(result.status, 'fail');
    const failed = result.assertions.find((a) => a.outcome === 'fail');
    assert.equal(failed?.expected, 'Monthly totals');
    assert.equal(failed?.criterion, 'the /dashboard page shows "Monthly totals"');
  });

  test('runInstructions for a browser failure reproduce it by hand', async () => {
    const result = await runRung({ broken: true });
    const parsed = parseRunInstructions(result.runInstructions);
    assert.ok(parsed, result.runInstructions);
    assert.equal(path.resolve(parsed.cwd), path.resolve(workspace));
    assert.match(parsed.url ?? '', /\/dashboard$/);
    assert.ok((parsed.steps ?? []).length >= 4);

    const { spawn } = await import('node:child_process');
    const manualPort = await freePort();
    const [bin, ...args] = parsed.command.split(' ');
    const child = spawn(bin, args, {
      cwd: parsed.cwd,
      env: { ...process.env, PORT: String(manualPort), HOST: '127.0.0.1', MN_BROKEN: '1' },
      windowsHide: true,
      stdio: 'ignore',
    });
    try {
      const manualUrl = new URL(parsed.url ?? '/');
      manualUrl.port = String(manualPort);
      let body = '';
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          body = await (await fetch(manualUrl)).text();
          break;
        } catch {
          if (Date.now() >= deadline) throw new Error(`manual repro never answered on ${manualUrl}`);
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      assert.equal(body.includes('Weekly totals'), false, 'the manual repro shows the same failure');
      assert.equal(body.includes('Something went wrong'), true);
    } finally {
      child.kill();
    }
  });

  test('driver unavailable produces blocked, and the run still finishes and reports', async () => {
    setBrowserToolLauncher(async () => ({
      ok: false,
      reason: 'no-browser',
      detail: 'simulated: no Chromium-family browser found',
    }));
    try {
      const result = await runRung();
      assert.equal(result.status, 'blocked');
      assert.equal(result.reason, 'browser-unavailable');
      assert.equal(result.assertions.every((a) => a.outcome === 'blocked'), true);
      assert.match(result.summary, /not a regression/);
      const status = await getDevServerStatusById(workspace);
      assert.notEqual(status.status, 'running');
    } finally {
      setBrowserToolLauncher(null);
    }
  });

  test('the full ladder runs the browser rung after a green static ladder', async () => {
    process.env.MN_BROKEN = '0';
    const result = await runFinalLadder({
      cwd: workspace,
      planMarkdown: planFor('Weekly totals'),
      browserOptions: { settleMs: 100, assertTimeoutMs: 5_000, readyTimeoutMs: 30_000 },
    });
    assert.equal(result.outcome, 'pass', JSON.stringify(result.evidence, null, 2));
    assert.deepEqual(result.evidence.ran, ['typecheck', 'lint', 'unit', 'build', 'browser']);
    assert.equal(result.evidence.browser.status, 'pass');
    assert.equal(result.evidence.rungs.at(-1).id, 'browser');
    assert.equal(parseRunInstructions(result.runInstructions)?.url?.length > 0, true);
  });

  test('a red static ladder launches no browser — by process count', async () => {
    const before = trackedBrowserPids().length;
    const broken = path.join(homeDir, 'red');
    await fsp.mkdir(broken, { recursive: true });
    await fsp.writeFile(
      path.join(broken, 'package.json'),
      `${JSON.stringify({
        name: 'p5c-red',
        private: true,
        scripts: {
          typecheck: 'node -e "process.exit(2)"',
          lint: 'node -e ""',
          test: 'node -e ""',
          build: 'node -e ""',
        },
      })}\n`,
      'utf8',
    );
    const result = await runFinalLadder({ cwd: broken, planMarkdown: planFor('Weekly totals') });
    assert.equal(result.outcome, 'fail');
    assert.equal(result.evidence.failedRung, 'typecheck');
    assert.equal(result.evidence.browser, null);
    assert.equal(trackedBrowserPids().length, before, 'no browser process may be started');
    assert.deepEqual(browserToolSessionKeys(), []);
  });

  test('ten consecutive runs against an unchanged app give ten identical results', async () => {
/** @type {string[]} */
    const verdicts = [];
    for (let i = 0; i < 10; i += 1) {
      const result = await runRung();
      verdicts.push(canonicalBrowserVerdict(result));
    }
    const unique = new Set(verdicts);
    assert.equal(
      unique.size,
      1,
      `expected one verdict across ten runs, got ${unique.size}:\n${[...unique].join('\n\n')}`,
    );
    assert.equal(JSON.parse(verdicts[0]).status, 'pass');
    assert.deepEqual(trackedBrowserPids(), [], 'ten runs must leak no browser');
  });
});
