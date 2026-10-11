import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { isParseErrors, parsePlan } from '../../server/orchestrator/core/parse-plan.js';
import { disposeEngines } from '../../server/orchestrator/engine.js';
import { resetJournalCache } from '../../server/orchestrator/journal.js';
import { createBoardsMiddleware } from '../../server/orchestrator/middleware.js';
import { runProcess } from '../../server/process-runner.js';
import { runWithViewWorkspace } from '../../server/runtime/path-access.js';
import { executeServerTool } from '../../server/runtime/tools-middleware.js';

const PLAN = `---
name: dependency-parity
overview: Add settings and use them.
todos:
  - id: W1-A
    content: "Wave 1: Settings"
    status: pending
  - id: W1-B
    content: "Wave 1: Consumer"
    status: pending
isProject: true
---

# Dependency parity

## Wave Breakdown

### Wave 1 — Settings

#### Task W1-A: Settings
- **Build:** CREATE \`src/settings.ts\` with \`export interface GameSettings {}\`.
- **Test:** Verify settings.
- **Accept:** Settings are available.
- **Touches:** src/settings.ts

#### Task W1-B: Consumer
- **Build:** Import GameSettings from \`src/settings.ts\`.
- **Test:** Verify the consumer.
- **Accept:** Consumer works.
- **Touches:** src/consumer.ts
`;
const PLAN_PATH = 'documentation/plans/parity.md';
const FIXED = PLAN.replace('#### Task W1-B: Consumer', '#### Task W1-B: Consumer\n- **Depends on:** W1-A');
let scratch;
let workspace;
let previousHome;
let server;
let base;

beforeEach(async () => {
  previousHome = process.env.MINNOW_HOME;
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-plan-parity-'));
  process.env.MINNOW_HOME = path.join(scratch, 'home');
  resetMinnowHomeCache();
  resetJournalCache();
  workspace = path.join(scratch, 'workspace');
  await fs.mkdir(path.join(workspace, 'documentation/plans'), { recursive: true });
  const initialized = await runProcess('git', ['init'], { cwd: workspace });
  assert.equal(initialized.code, 0, initialized.stderr);
  const middleware = createBoardsMiddleware();
  server = http.createServer((req, res) => {
    void runWithViewWorkspace(workspace, () => middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  disposeEngines();
  await new Promise((resolve) => server.close(resolve));
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetJournalCache();
  await fs.rm(scratch, { recursive: true, force: true });
});

async function writeAndCheck(markdown) {
  await fs.writeFile(path.join(workspace, PLAN_PATH), markdown);
  return (await executeServerTool('check_plan', { path: PLAN_PATH }, { workspaceRoot: workspace })).result;
}

async function post(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('agent check, board intake, and resync agree on missing dependencies and their repair', async () => {
  // This was the false positive: syntax alone passes, but isolated tasks cannot run it.
  assert.equal(isParseErrors(parsePlan(PLAN)), false);
  const checked = await writeAndCheck(PLAN);
  const rejected = await post('/api/boards', { planPath: PLAN_PATH });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.detail, /W1-B uses work introduced by W1-A/);
  assert.equal(checked, `Plan does not parse:\n${rejected.body.detail}`);

  assert.match(await writeAndCheck(FIXED), /Plan parses successfully: 2 task/);
  const created = await post('/api/boards', { planPath: PLAN_PATH });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const boardRoute = `/api/boards/${created.body.boardId}`;
  const journalBefore = await (await fetch(`${base}${boardRoute}/journal`)).json();
  const resyncCheck = await writeAndCheck(PLAN);
  const resync = await post(`${boardRoute}/resync`, {});
  assert.equal(resync.status, 400);
  assert.deepEqual(resync.body.errors, rejected.body.errors);
  assert.equal(resyncCheck, `Plan does not parse:\n${resync.body.detail}`);
  assert.deepEqual(await (await fetch(`${base}${boardRoute}/journal`)).json(), journalBefore);

  assert.match(await writeAndCheck(FIXED), /Plan parses successfully/);
  assert.equal((await post(`${boardRoute}/resync`, {})).status, 200);
});

test('agent check and board intake use the request workspace, including untracked existing files', async () => {
  await fs.mkdir(path.join(workspace, 'src'));
  await fs.writeFile(path.join(workspace, 'src/settings.ts'), 'export interface GameSettings {}');
  assert.match(await writeAndCheck(PLAN), /Plan parses successfully/);
  const created = await post('/api/boards', { planPath: PLAN_PATH });
  assert.equal(created.status, 201, JSON.stringify(created.body));
});

test('agent check and board intake agree on npm script dependencies', async () => {
  const markdown = PLAN
    .replace('- **Build:** CREATE `src/settings.ts` with `export interface GameSettings {}`.',
      '- **Build:** Add scripts `"test:widget": "vitest run"`.')
    .replace('- **Touches:** src/settings.ts', '- **Touches:** package.json')
    .replace('- **Build:** Import GameSettings from `src/settings.ts`.', '- **Build:** Add the consumer.')
    .replace('- **Test:** Verify the consumer.', '- **Test:** Run `npm run test:widget`.');
  const checked = await writeAndCheck(markdown);
  const rejected = await post('/api/boards', { planPath: PLAN_PATH });
  assert.equal(rejected.status, 400);
  assert.equal(checked, `Plan does not parse:\n${rejected.body.detail}`);
  assert.match(checked, /W1-B uses work introduced by W1-A/);
});

test('agent check and board intake retain identical syntax diagnostics', async () => {
  const checked = await writeAndCheck(PLAN.replace('- **Test:** Verify the consumer.\n', ''));
  const rejected = await post('/api/boards', { planPath: PLAN_PATH });
  assert.equal(rejected.status, 400);
  assert.equal(checked, `Plan does not parse:\n${rejected.body.detail}`);
  assert.match(checked, /has no \*\*Test:\*\*/);
});
