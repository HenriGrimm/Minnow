/**
 * P5-C — Browser rung of the Final Tester ladder (MIN-721), no browser.
 *
 * Everything here runs on bare node with no Chromium and no dev server: the
 * derivation is pure, and the execution path takes injected tool / app control
 * seams. The live half (a real browser, a real app, ten consecutive runs) is
 * `browser-rung-live.test.mjs`.
 */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  BROWSER_BLOCKED_PREFIX,
  BROWSER_UNAVAILABLE_PREFIX,
  canonicalBrowserVerdict,
  classifyToolError,
  compileAcceptCriterion,
  deriveBrowserAssertions,
  describeAssertion,
  extractPath,
  formatBrowserRunInstructions,
  pageBody,
  runBrowserRung,
  statusForUrl,
  waitForPortFree,
  verificationChecklistProse,
} from '../../server/orchestrator/browser-rung.js';
import {
  ALL_RUNG_IDS,
  parseRunInstructions,
  runFinalLadder,
} from '../../server/orchestrator/final-test.js';
import { withStrictPort } from '../../server/dev-server/effective-guide.js';

const PLAN = `---
name: dashboard-rollout
overview: Ship the dashboard.
todos:
  - id: T1
    content: "Wave 1: Render the dashboard header"
    status: pending
  - id: T2
    content: "Wave 1: Remove the legacy banner"
    status: pending
  - id: T3
    content: "Wave 1: Pure helper"
    status: pending
isProject: false
---

# Dashboard Rollout

## Wave Breakdown

### Wave 1 — Foundations

#### Task T1: Render the dashboard header
- **Build:** Add the header in \`src/dashboard.ts\`.
- **Test:** \`npm test\` passes.
- **Accept:** the /dashboard page shows "Weekly totals"
- **Touches:** src/dashboard.ts

#### Task T2: Remove the legacy banner
- **Build:** Delete the banner in \`src/banner.ts\`.
- **Test:** \`npm test\` passes.
- **Accept:** the /dashboard page no longer shows "Beta preview"
- **Touches:** src/banner.ts

#### Task T3: Pure helper
- **Build:** Add \`formatMoney()\` in \`src/money.ts\`.
- **Test:** \`npm test\` passes.
- **Accept:** formatMoney rounds half to even
- **Touches:** src/money.ts

## Verification Checklist
- [ ] \`npm run typecheck\` passes
- [ ] \`npm test\` passes
- [ ] the console has no errors on /dashboard
`;

/**
 * The same plan with one more task appended inside the Wave Breakdown, so the
 * document still parses. Appending after `## Verification Checklist` would put
 * the task outside the section the scheduler reads.
 *
 * @param {string} id
 * @param {string} title
 * @param {string} accept
 */
function withExtraTask(id, title, accept) {
  const marker = '\n## Verification Checklist';
  const task = [
    '',
    `#### Task ${id}: ${title}`,
    '- **Build:** Add it.',
    '- **Test:** `npm test` passes.',
    `- **Accept:** ${accept}`,
    '- **Touches:** src/extra.ts',
    '',
  ].join('\n');
  const withTask = PLAN.replace(marker, `${task}${marker}`);
  return withTask.replace(
    'isProject: false',
    `  - id: ${id}\n    content: "Wave 1: ${title}"\n    status: pending\nisProject: false`,
  );
}

/** A tool caller backed by a scripted page. */
function fakeTools(page = {}) {
  const calls = [];
  const text = page.text ?? 'Weekly totals for the week';
  const title = page.title ?? 'Dashboard';
  const console_ = page.console ?? 'console: (no entries)';
  const network = page.network ?? 'network: (no requests recorded)';
  const overrides = page.overrides ?? {};
  const call = async (name, args = {}) => {
    calls.push({ name, args });
    if (overrides[name]) return overrides[name];
    if (name === 'browser_drive_navigate') {
      return `outcome: loaded\nurl: ${args.url}\ntitle: ${title}`;
    }
    if (name === 'browser_drive_read_page') {
      return `url: ${page.url ?? 'http://127.0.0.1:5173/dashboard'}\nmode: text\n---\n${text}`;
    }
    if (name === 'browser_drive_read_console') return console_;
    if (name === 'browser_drive_read_network') return network;
    if (name === 'browser_drive_screenshot') {
      return 'screenshot: shot-1\npath: C:\\shots\\shot-1.png\nbytes: 100';
    }
    return '';
  };
  call.calls = calls;
  return call;
}

/** An app control that starts nothing. */
function fakeApp(url = 'http://127.0.0.1:5173/') {
  const log = [];
  return {
    log,
    async start() {
      log.push('start');
      return { ok: true, url, command: 'npm run dev -- --port 5173 --strictPort', port: 5173, startedHere: true };
    },
    async stop() {
      log.push('stop');
    },
  };
}

// ── Derivation ───────────────────────────────────────────────────────────────

describe('P5-C derivation — assertions come from the plan, never from a guess', () => {
  test('an Accept criterion with quoted on-screen text becomes a text assertion', () => {
    const compiled = compileAcceptCriterion('the /dashboard page shows "Weekly totals"');
    assert.deepEqual(compiled, {
      kind: 'text',
      path: '/dashboard',
      absoluteUrl: null,
      expected: 'Weekly totals',
    });
  });

  test('negation before the quote flips it to an absence check', () => {
    const compiled = compileAcceptCriterion('the /dashboard page no longer shows "Beta preview"');
    assert.equal(compiled?.kind, 'absent-text');
    assert.equal(compiled?.expected, 'Beta preview');
  });

  test('the Planner prompt\'s own example compiles to an HTTP status assertion', () => {
    const compiled = compileAcceptCriterion('the /foo route returns 200 with field bar');
    assert.deepEqual(compiled, {
      kind: 'http-status',
      path: '/foo',
      absoluteUrl: null,
      expected: '200',
    });
  });

  test('console cleanliness is its own kind', () => {
    assert.equal(compileAcceptCriterion('the console has no errors on /dashboard')?.kind, 'console-clean');
    assert.equal(compileAcceptCriterion('loads /x with no console errors')?.kind, 'console-clean');
  });

  test('a title criterion reads the document title, not the body', () => {
    const compiled = compileAcceptCriterion('the document title is "Minnow — Dashboard"');
    assert.equal(compiled?.kind, 'title');
    assert.equal(compiled?.expected, 'Minnow — Dashboard');
  });

  test('a criterion a browser cannot see compiles to nothing', () => {
    assert.equal(compileAcceptCriterion('formatMoney rounds half to even'), null);
    assert.equal(compileAcceptCriterion('the exported type no longer widens to any'), null);
    assert.equal(compileAcceptCriterion(''), null);
  });

  test('a touches glob is not mistaken for a route', () => {
    assert.equal(extractPath('src/**/*.ts'), null);
    assert.equal(extractPath('open /settings')?.path, '/settings');
    assert.equal(extractPath('open http://localhost:4000/x?y=1')?.path, '/x?y=1');
  });

  test('derivation reads every task plus the non-command checklist prose', () => {
    const derived = deriveBrowserAssertions(PLAN);
    assert.deepEqual(
      derived.assertions.map((a) => `${a.kind} ${a.path} ${a.expected}`),
      [
        'text /dashboard Weekly totals',
        'absent-text /dashboard Beta preview',
        'console-clean /dashboard no console errors',
      ],
    );
    assert.deepEqual(
      derived.assertions.map((a) => a.source),
      ['accept', 'accept', 'checklist'],
    );
    assert.deepEqual(derived.notObservable, [
      {
        taskId: 'T3',
        source: 'accept',
        criterion: 'formatMoney rounds half to even',
        reason: 'not-browser-observable',
      },
    ]);
  });

  test('checklist ladder commands are not re-run as browser assertions', () => {
    assert.deepEqual(verificationChecklistProse(PLAN), ['the console has no errors on /dashboard']);
  });

  test('changing one Accept criterion changes exactly one assertion', () => {
    const before = deriveBrowserAssertions(PLAN);
    const after = deriveBrowserAssertions(PLAN.replace('"Weekly totals"', '"Monthly totals"'));
    const diff = after.assertions.filter(
      (a, i) => JSON.stringify(a) !== JSON.stringify(before.assertions[i]),
    );
    assert.equal(diff.length, 1);
    assert.equal(diff[0].expected, 'Monthly totals');
    assert.equal(diff[0].taskId, 'T1');
  });

  test('two tasks asserting the same thing collapse to one navigation', () => {
    const twice = PLAN.replace('formatMoney rounds half to even', 'the /dashboard page shows "Weekly totals"');
    assert.equal(deriveBrowserAssertions(twice).assertions.length, 3);
  });

  test('assertion order is a function of the plan text alone', () => {
    const a = deriveBrowserAssertions(PLAN);
    const b = deriveBrowserAssertions(PLAN);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

// ── Evidence readers ─────────────────────────────────────────────────────────

describe('P5-C evidence readers', () => {
  test('the page-read header cannot satisfy an assertion about the body', () => {
    const out = 'url: http://127.0.0.1:5173/settings\nmode: text\n---\nnothing here';
    assert.equal(pageBody(out).includes('settings'), false);
  });

  test('network status is read out of the deterministic row format', () => {
    const out = 'network: 2 requests (sorted by url, method, status)\n---\nGET 200 http://a/x\nGET 404 http://a/y';
    assert.equal(statusForUrl(out, 'http://a/y'), '404');
    assert.equal(statusForUrl(out, 'http://a/zzz'), null);
  });

  test('driver failures are classified apart from answers', () => {
    assert.equal(classifyToolError(`${BROWSER_UNAVAILABLE_PREFIX} (no-browser): x`), 'browser-unavailable');
    assert.equal(classifyToolError(`${BROWSER_BLOCKED_PREFIX}: http://evil`), 'navigation-blocked');
    assert.equal(classifyToolError('Error: the browser session ended'), 'driver-error');
    assert.equal(classifyToolError('outcome: loaded'), null);
  });

  test('run instructions carry command, cwd, url and steps, and parse back', () => {
    const text = formatBrowserRunInstructions({
      command: 'npm run dev -- --port 5173 --strictPort',
      cwd: 'C:\\repo',
      url: 'http://127.0.0.1:5173/dashboard',
      steps: ['start the app', 'open the url', 'expect: page text contains "Weekly totals"'],
    });
    const parsed = parseRunInstructions(text);
    assert.equal(parsed?.command, 'npm run dev -- --port 5173 --strictPort');
    assert.equal(parsed?.cwd, 'C:\\repo');
    assert.equal(parsed?.url, 'http://127.0.0.1:5173/dashboard');
    assert.equal(parsed?.steps?.length, 3);
  });

  test('describeAssertion is the sentence a human reproduces', () => {
    assert.equal(
      describeAssertion({ kind: 'text', expected: 'Weekly totals', path: '/x' }),
      'page text contains "Weekly totals"',
    );
  });
});

// ── Blocked ──────────────────────────────────────────────────────────────────

describe('P5-C blocked is not fail', () => {
  test('a plan with no observable criterion blocks; it does not pass silently', async () => {
    const result = await runBrowserRung({
      cwd: os.tmpdir(),
      planMarkdown: PLAN.replace(/the \/dashboard page[^\n]*/g, 'the module compiles').replace(
        'the console has no errors on /dashboard',
        '`npm run build` passes',
      ),
      app: fakeApp(),
      callTool: fakeTools(),
      closeBrowser: async () => {},
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'no-observable-criteria');
    assert.deepEqual(result.assertions, []);
  });

  test('a missing browser blocks the rung and stops it immediately', async () => {
    const tools = fakeTools({
      overrides: {
        browser_drive_navigate: `${BROWSER_UNAVAILABLE_PREFIX} (no-browser): no Chromium found`,
      },
    });
    const app = fakeApp();
    const result = await runBrowserRung({
      cwd: os.tmpdir(),
      planMarkdown: PLAN,
      app,
      callTool: tools,
      closeBrowser: async () => {},
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'browser-unavailable');
    assert.equal(result.assertions.every((a) => a.outcome === 'blocked'), true);
    assert.equal(tools.calls.filter((c) => c.name === 'browser_drive_navigate').length, 1);
    assert.deepEqual(app.log, ['start', 'stop']);
  });

  test('an allowlist refusal blocks rather than fails', async () => {
    const result = await runBrowserRung({
      cwd: os.tmpdir(),
      planMarkdown: PLAN,
      app: fakeApp(),
      callTool: fakeTools({
        overrides: { browser_drive_navigate: `${BROWSER_BLOCKED_PREFIX}: http://127.0.0.1:5173` },
      }),
      closeBrowser: async () => {},
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'navigation-blocked');
  });

  test('a driver crash mid-read blocks rather than fails', async () => {
    const result = await runBrowserRung({
      cwd: os.tmpdir(),
      planMarkdown: PLAN,
      app: fakeApp(),
      callTool: async (name, args = {}) => {
        if (name === 'browser_drive_navigate') return `outcome: loaded\nurl: ${args.url}\ntitle: t`;
        if (name === 'browser_drive_screenshot') return 'screenshot: s\npath: p\nbytes: 1';
        throw new Error('websocket closed');
      },
      closeBrowser: async () => {},
      captureScreenshots: false,
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'driver-error');
    assert.match(result.summary, /websocket closed/);
  });

  test('a dev server that will not start blocks, and nothing is left running', async () => {
    const stopped = [];
    const result = await runBrowserRung({
      cwd: os.tmpdir(),
      planMarkdown: PLAN,
      app: {
        async start() {
          return { ok: false, reason: 'dev-server-unhealthy', detail: 'no answer on port 5173', startedHere: true };
        },
        async stop() {
          stopped.push('stop');
        },
      },
      callTool: fakeTools(),
      closeBrowser: async () => {},
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'dev-server-unhealthy');
    assert.deepEqual(stopped, ['stop']);
  });

  test('a real failing assertion outranks a blocked sibling', async () => {
    let navCount = 0;
    const result = await runBrowserRung({
      cwd: os.tmpdir(),
      planMarkdown: `${PLAN}\n### T4 — Settings\n\n- **Build:** x\n- **Test:** \`npm test\`\n- **Accept:** the /settings page shows "Profile"\n- **Touches:** x\n`,
      app: fakeApp(),
      callTool: async (name, args = {}) => {
        if (name === 'browser_drive_navigate') {
          navCount += 1;
          if (String(args.url).includes('/settings')) return 'Error: the browser session ended';
          return `outcome: loaded\nurl: ${args.url}\ntitle: Dashboard`;
        }
        if (name === 'browser_drive_read_page') return 'url: x\nmode: text\n---\nnothing at all';
        if (name === 'browser_drive_read_console') return 'console: (no entries)';
        return '';
      },
      closeBrowser: async () => {},
      captureScreenshots: false,
      assertTimeoutMs: 0,
    });
    assert.equal(navCount, 2);
    assert.equal(result.status, 'fail');
    assert.equal(result.assertions.some((a) => a.outcome === 'blocked'), true);
  });
});

// ── Fail ─────────────────────────────────────────────────────────────────────

describe('P5-C fail is specific and reproducible', () => {
  test('a broken UI fails with the criterion, the url, and what was observed', async () => {
    const result = await runBrowserRung({
      cwd: 'C:\\repo',
      planMarkdown: PLAN,
      app: fakeApp(),
      callTool: fakeTools({ text: 'an empty shell' }),
      closeBrowser: async () => {},
      assertTimeoutMs: 0,
      settleMs: 0,
    });
    assert.equal(result.status, 'fail');
    const failed = result.assertions.find((a) => a.outcome === 'fail');
    assert.equal(failed?.taskId, 'T1');
    assert.equal(failed?.describe, 'page text contains "Weekly totals"');
    assert.match(result.summary, /Weekly totals/);

    const parsed = parseRunInstructions(result.runInstructions);
    assert.equal(parsed?.command, 'npm run dev -- --port 5173 --strictPort');
    assert.equal(parsed?.cwd, 'C:\\repo');
    assert.equal(parsed?.url, 'http://127.0.0.1:5173/dashboard');
    assert.equal(
      parsed?.steps?.some((s) => s.includes("task T1's Accept")),
      true,
    );
  });

  test('an absence criterion fails when the text is still there', async () => {
    const result = await runBrowserRung({
      cwd: 'C:\\repo',
      planMarkdown: PLAN,
      app: fakeApp(),
      callTool: fakeTools({ text: 'Weekly totals — Beta preview' }),
      closeBrowser: async () => {},
      assertTimeoutMs: 0,
      settleMs: 0,
    });
    assert.equal(result.status, 'fail');
    const failed = result.assertions.find((a) => a.outcome === 'fail');
    assert.equal(failed?.kind, 'absent-text');
    assert.equal(failed?.taskId, 'T2');
  });

  test('console errors fail the console-clean criterion, quoting them', async () => {
    const result = await runBrowserRung({
      cwd: 'C:\\repo',
      planMarkdown: PLAN,
      app: fakeApp(),
      callTool: fakeTools({ console: 'console: 1 entries\n---\n[error] Uncaught TypeError: x is not a function' }),
      closeBrowser: async () => {},
      assertTimeoutMs: 0,
      settleMs: 0,
    });
    assert.equal(result.status, 'fail');
    const failed = result.assertions.find((a) => a.kind === 'console-clean');
    assert.equal(failed?.outcome, 'fail');
    assert.match(failed?.detail ?? '', /Uncaught TypeError/);
  });

  test('a passing app passes, and screenshots are evidence rather than assertions', async () => {
    const shotless = fakeTools({ overrides: { browser_drive_screenshot: 'screenshot: not captured (timeout).' } });
    const result = await runBrowserRung({
      cwd: 'C:\\repo',
      planMarkdown: PLAN.replace('no longer shows "Beta preview"', 'no longer shows "Legacy banner"'),
      app: fakeApp(),
      callTool: shotless,
      closeBrowser: async () => {},
      settleMs: 0,
    });
    assert.equal(result.status, 'pass');
    assert.deepEqual(result.screenshots, []);
    assert.equal(result.assertions.length, 3);
  });
});

// ── Teardown ─────────────────────────────────────────────────────────────────

describe('P5-C teardown', () => {
  test('the browser and the app are torn down on every path, including a throw', async () => {
    const closed = [];
    const app = fakeApp();
    await runBrowserRung({
      cwd: 'C:\\repo',
      planMarkdown: PLAN,
      app,
      callTool: async () => {
        throw new Error('boom');
      },
      closeBrowser: async (cwd) => closed.push(cwd),
    });
    assert.deepEqual(closed, ['C:\\repo']);
    assert.deepEqual(app.log, ['start', 'stop']);
  });

  test('an app that was already running is not stopped by the rung', async () => {
    const log = [];
    await runBrowserRung({
      cwd: 'C:\\repo',
      planMarkdown: PLAN,
      app: {
        async start() {
          log.push('start');
          return { ok: true, url: 'http://127.0.0.1:5173/', command: 'x', port: 5173, startedHere: false };
        },
        async stop() {
          log.push('stop');
        },
      },
      callTool: fakeTools(),
      closeBrowser: async () => {},
      settleMs: 0,
    });
    assert.deepEqual(log, ['start']);
  });
});

describe('P5-C the pinned port is not shared with a dying predecessor', () => {
  /** @returns {Promise<{ port: number, close: () => Promise<void> }>} */
  function listen() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => socket.end());
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
        resolve({
          port,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
  }

  test('a free port is reported free immediately', async () => {
    const held = await listen();
    const { port } = held;
    await held.close();
    assert.equal(await waitForPortFree(port, { timeoutMs: 2_000 }), true);
  });

  test('a held port is waited on, and reported free the moment it closes', async () => {
    const held = await listen();
    setTimeout(() => void held.close(), 300);
    const t0 = Date.now();
    assert.equal(await waitForPortFree(held.port, { timeoutMs: 5_000 }), true);
    assert.ok(Date.now() - t0 >= 200, 'it must actually have waited, not guessed');
  });

  test('a port that never frees hits the deadline and says so', async () => {
    const held = await listen();
    try {
      assert.equal(await waitForPortFree(held.port, { timeoutMs: 600 }), false);
    } finally {
      await held.close();
    }
  });

  test('an occupied pinned port blocks the rung rather than verifying a stranger', async () => {
    const result = await runBrowserRung({
      cwd: 'C:\repo',
      planMarkdown: PLAN,
      app: {
        async start() {
          return {
            ok: false,
            reason: 'dev-server-unhealthy',
            detail: 'port 5173 is already in use by something this rung did not start',
            command: 'npm run dev',
            port: 5173,
            startedHere: false,
          };
        },
        async stop() {
          assert.fail('nothing was started, so nothing may be stopped');
        },
      },
      callTool: async () => assert.fail('no browser may be launched'),
      closeBrowser: async () => {},
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'dev-server-unhealthy');
    assert.match(result.summary, /already in use/);
  });
});

// ── Quoted identifiers ───────────────────────────────────────────────────────

describe('P5-C a quoted identifier is not a page assertion', () => {
  const NON_UI = [
    'the observe catalogue module exports "JOURNAL_EVENT_TYPES" and it is sorted.',
    'renderRunReport output contains a "What did not ship" section.',
    'LADDER_RUNGS has five entries ending in "browser".',
    'journalSize returns "bytes" and "events" as finite numbers.',
    'takeSample returns a record with "elapsedMs", "journal", "memory" and "browsers".',
    'the observe barrel exports "journalSize", "memoryCensus" and "JOURNAL_EVENT_TYPES".',
    'memoryCensus reports a positive "rss".',
    'tokenCost separates "total_tokens" from "attemptsWithoutUsage".',
  ];

  for (const criterion of NON_UI) {
    test(`not browser-observable: ${criterion.slice(0, 48)}…`, () => {
      assert.equal(compileAcceptCriterion(criterion), null);
    });
  }

  test('a route is anchor enough on its own', () => {
    assert.equal(compileAcceptCriterion('/settings shows "Profile"')?.kind, 'text');
  });

  test('a UI noun is anchor enough without a route', () => {
    const compiled = compileAcceptCriterion('the header displays "Weekly totals"');
    assert.equal(compiled?.kind, 'text');
    assert.equal(compiled?.path, '/', 'with no route named, the app entry point is the page');
  });

  test('"browser" alone is not a UI noun', () => {
    assert.equal(compileAcceptCriterion('the list ends with "browser"'), null);
  });

  test('a bare title field is not a document title', () => {
    assert.equal(compileAcceptCriterion('the config title is "Minnow"'), null);
    assert.equal(compileAcceptCriterion('the document title is "Minnow"')?.kind, 'title');
    assert.equal(compileAcceptCriterion('/x title is "Minnow"')?.kind, 'title');
  });

  test('the whole P5-D plan yields no browser assertions, and says so', async () => {
    const planPath = path.join(
      process.cwd(),
      'test',
      'fixtures',
      'orchestrator-v2-p5d',
      'plan.md',
    );
    const markdown = await fsp.readFile(planPath, 'utf8');
    const derived = deriveBrowserAssertions(markdown);
    assert.deepEqual(derived.assertions, [], 'a plan with no UI must assert nothing in a browser');
    assert.ok(derived.notObservable.length >= 18, 'and every criterion must be reported, not dropped');
  });

  test('a non-UI plan blocks the rung rather than failing it', async () => {
    const planPath = path.join(
      process.cwd(),
      'test',
      'fixtures',
      'orchestrator-v2-p5d',
      'plan.md',
    );
    const result = await runBrowserRung({
      cwd: process.cwd(),
      planMarkdown: await fsp.readFile(planPath, 'utf8'),
      app: null,
      callTool: async () => assert.fail('no browser may be launched for a plan with nothing to check'),
      closeBrowser: async () => {},
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'no-observable-criteria');
  });
});

// ── Static ladder ────────────────────────────────────────────────────────────

describe('P5-C the static ladder gates the browser rung', () => {
  /**
   * @param {string} dir
   * @param {'pass' | 'type-error'} mode
   */
  async function writeFixture(dir, mode) {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'p5c-fixture',
          private: true,
          scripts: {
            typecheck: mode === 'type-error' ? 'node -e "process.exit(1)"' : 'node -e ""',
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
  }

  test('a build failure at rung 1 means no browser is ever launched', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mn-p5c-gate-'));
    await writeFixture(dir, 'type-error');
    let launched = 0;
    const result = await runFinalLadder({
      cwd: dir,
      planMarkdown: PLAN,
      browserRung: async () => {
        launched += 1;
        return { status: 'pass', reason: null, summary: 'x', runInstructions: '', url: null, appCommand: null, port: null, assertions: [], notObservable: [], screenshots: [] };
      },
    });
    assert.equal(result.outcome, 'fail');
    assert.equal(result.evidence.failedRung, 'typecheck');
    assert.equal(launched, 0, 'the browser rung must not run behind a red static ladder');
    assert.equal(result.evidence.browser, null);
    assert.equal(result.evidence.rungs.some((r) => r.id === 'browser'), false);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('a green static ladder reaches the browser rung', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mn-p5c-green-'));
    await writeFixture(dir, 'pass');
    const seen = [];
    const result = await runFinalLadder({
      cwd: dir,
      planMarkdown: PLAN,
      browserRung: async (input) => {
        seen.push(input.planMarkdown);
        return {
          status: 'pass',
          reason: null,
          summary: 'Browser rung passed: 3 derived assertions held.',
          runInstructions: 'command: npm run dev\ncwd: x\nurl: http://127.0.0.1:5173/\nsteps:\n  1. open it',
          url: 'http://127.0.0.1:5173/',
          appCommand: 'npm run dev',
          port: 5173,
          assertions: [],
          notObservable: [],
          screenshots: [{ id: 's1', path: '/', url: 'http://127.0.0.1:5173/' }],
        };
      },
    });
    assert.equal(result.outcome, 'pass');
    assert.deepEqual(result.evidence.ran, ['typecheck', 'lint', 'unit', 'build', 'browser']);
    assert.equal(result.evidence.browser.status, 'pass');
    assert.equal(result.evidence.browser.screenshots.length, 1);
    assert.equal(seen[0].includes('Weekly totals'), true, 'the rung is handed the plan');
    assert.deepEqual(
      result.evidence.rungs.map((r) => [r.id, r.outcome]),
      [['typecheck', 'pass'], ['lint', 'pass'], ['unit', 'pass'], ['build', 'pass'], ['browser', 'pass']],
    );
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('a blocked browser rung keeps the run green and journals the reason', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mn-p5c-blocked-'));
    await writeFixture(dir, 'pass');
    const result = await runFinalLadder({
      cwd: dir,
      planMarkdown: PLAN,
      browserRung: async () => ({
        status: 'blocked',
        reason: 'browser-unavailable',
        summary: 'Browser rung blocked (browser-unavailable): no Chromium.',
        runInstructions: 'command: x\ncwd: y',
        url: null,
        appCommand: null,
        port: null,
        assertions: [],
        notObservable: [],
        screenshots: [],
      }),
    });
    assert.equal(result.outcome, 'pass', 'a missing browser must never fail the run');
    assert.equal(result.evidence.failedRung, null);
    assert.equal(result.evidence.blockedRung, 'browser');
    assert.equal(result.evidence.browser.status, 'blocked');
    assert.equal(result.evidence.browser.reason, 'browser-unavailable');
    assert.deepEqual(result.evidence.ran, ['typecheck', 'lint', 'unit', 'build']);
    assert.equal(result.evidence.rungs.at(-1).outcome, 'blocked');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('a failing browser rung fails the run and carries its own runInstructions', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mn-p5c-red-'));
    await writeFixture(dir, 'pass');
    const result = await runFinalLadder({
      cwd: dir,
      planMarkdown: PLAN,
      browserRung: async () => ({
        status: 'fail',
        reason: null,
        summary: 'Browser rung failed: page text contains "Weekly totals" at http://x/ — not found.',
        runInstructions: 'command: npm run dev\ncwd: q\nurl: http://x/\nsteps:\n  1. open http://x/',
        url: 'http://x/',
        appCommand: 'npm run dev',
        port: 5173,
        assertions: [],
        notObservable: [],
        screenshots: [],
      }),
    });
    assert.equal(result.outcome, 'fail');
    assert.equal(result.evidence.failedRung, 'browser');
    assert.equal(result.evidence.blockedRung, null);
    assert.equal(parseRunInstructions(result.runInstructions)?.url, 'http://x/');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('a browser rung that never returns is blocked, not a hung attempt', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mn-p5c-hang-'));
    await writeFixture(dir, 'pass');
    const result = await runFinalLadder({
      cwd: dir,
      planMarkdown: PLAN,
      browserTimeoutMs: 50,
      browserRung: () => new Promise(() => {}),
    });
    assert.equal(result.outcome, 'pass');
    assert.equal(result.evidence.browser.status, 'blocked');
    assert.equal(result.evidence.browser.reason, 'driver-error');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('browser: false opts the rung out entirely', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mn-p5c-off-'));
    await writeFixture(dir, 'pass');
    let launched = 0;
    const result = await runFinalLadder({
      cwd: dir,
      planMarkdown: PLAN,
      browser: false,
      browserRung: async () => {
        launched += 1;
        throw new Error('unreachable');
      },
    });
    assert.equal(result.outcome, 'pass');
    assert.equal(launched, 0);
    assert.equal(result.evidence.browser, null);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('ALL_RUNG_IDS names the browser last', () => {
    assert.deepEqual([...ALL_RUNG_IDS], ['typecheck', 'lint', 'unit', 'build', 'browser']);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe('P5-C determinism', () => {
  test('ten runs against one unchanged scripted app give one verdict', async () => {
    const verdicts = new Set();
    for (let i = 0; i < 10; i += 1) {
      const result = await runBrowserRung({
        cwd: 'C:\\repo',
        planMarkdown: PLAN,
        app: fakeApp(),
        callTool: fakeTools(),
        closeBrowser: async () => {},
        settleMs: 0,
      });
      verdicts.add(canonicalBrowserVerdict(result));
    }
    assert.equal(verdicts.size, 1, [...verdicts].join('\n--\n'));
  });

  test('the canonical verdict excludes screenshot ids, which are timestamps', () => {
    const base = {
      status: 'pass',
      reason: null,
      summary: 's',
      runInstructions: 'r',
      url: 'u',
      appCommand: 'c',
      assertions: [],
      notObservable: [],
    };
    assert.equal(
      canonicalBrowserVerdict({ ...base, screenshots: [{ id: 'a', path: '/', url: 'u' }] }),
      canonicalBrowserVerdict({ ...base, screenshots: [{ id: 'b', path: '/', url: 'u' }] }),
    );
  });
});

// ── Port pinning ─────────────────────────────────────────────────────────────

describe('P5-C port pinning', () => {
  test('strictPort is added beside an existing --port and is idempotent', () => {
    assert.equal(
      withStrictPort('npm run dev -- --port 5173'),
      'npm run dev -- --port 5173 --strictPort',
    );
    assert.equal(
      withStrictPort('npm run dev -- --port 5173 --strictPort'),
      'npm run dev -- --port 5173 --strictPort',
    );
  });

  test('a command with no port is left alone', () => {
    assert.equal(withStrictPort('node server.mjs'), 'node server.mjs');
  });

  test('a split stack gets the flag inside the client segment, not on concurrently', () => {
    assert.equal(
      withStrictPort('npx concurrently "npm run dev:server" "npm run dev:client -- --port 3000"'),
      'npx concurrently "npm run dev:server" "npm run dev:client -- --port 3000 --strictPort"',
    );
  });
});

// ── P5-B sync ────────────────────────────────────────────────────────────────

describe('P5-C stays in sync with P5-B', () => {
  test('the degradation prefixes match the tool surface exactly', async () => {
    const tools = await import('../../server/tools/browser-driver-tools.js');
    assert.equal(BROWSER_UNAVAILABLE_PREFIX, tools.BROWSER_UNAVAILABLE_PREFIX);
    assert.equal(BROWSER_BLOCKED_PREFIX, tools.BROWSER_BLOCKED_PREFIX);
  });

  test('every tool the rung calls is dispatchable by the rung and by nobody else', async () => {
    const { dispatchToolIdsForRole, headlessToolIdsForRole } = await import(
      '../../server/runner/tool-set.js'
    );
    const used = [
      'browser_drive_navigate',
      'browser_drive_read_page',
      'browser_drive_read_console',
      'browser_drive_read_network',
      'browser_drive_screenshot',
    ];
    const rung = new Set(dispatchToolIdsForRole('final'));
    // The rung drives these from code; no role's model is shown them.
    const finalModel = new Set(headlessToolIdsForRole('final'));
    const builder = new Set(dispatchToolIdsForRole('builder'));
    for (const id of used) {
      assert.equal(rung.has(id), true, `${id} must be dispatchable by the browser rung`);
      assert.equal(finalModel.has(id), false, `${id} must not be shown to the Final Tester`);
      assert.equal(builder.has(id), false, `${id} must not be available to a Builder`);
    }
  });
});
