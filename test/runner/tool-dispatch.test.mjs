/**
 * P2-D — in-process tool dispatch (MIN-701).
 *
 * Guards must fire identically to POST /api/tools. cwd is required. The default
 * headless tool set contains no renderer-only tool.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MINNOW_DEFAULT_PORT } from '../../server/constants/minnow-port.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { createToolsMiddleware } from '../../server/runtime/tools-middleware.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../../server/tools/output-cap.js';
import { initWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';
import { getWorktreesRoot } from '../../server/worktree/paths.js';
import {
  createInProcessToolDispatch,
  executeInProcessTool,
} from '../../server/runner/tool-dispatch.js';
import {
  DEFAULT_HEADLESS_TOOL_IDS,
  RENDERER_ONLY_TOOL_IDS,
  rendererOnlyToolsIn,
} from '../../server/runner/tool-set.js';
import { rmTestHome, setTestHome } from '../config/test-helpers.js';

const isWin32 = process.platform === 'win32';
const livePort = String(MINNOW_DEFAULT_PORT);

/**
 * @param {http.RequestListener} listener
 * @returns {Promise<{ server: http.Server, baseUrl: string }>}
 */
function listen(listener) {
  const server = http.createServer(listener);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

/** POST /api/tools against a local tools-middleware server. */
async function postTools(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe('in-process tool dispatch', { concurrency: false }, () => {
  /** @type {string} */
  let homeDir = '';
  /** @type {string} */
  let codeWorkspace = '';
  /** @type {http.Server | null} */
  let server = null;
  /** @type {string} */
  let baseUrl = '';

  before(async () => {
    homeDir = setTestHome(process.env, 'minnow-test-p2d-dispatch');
    await ensureMinnowLayout();
    codeWorkspace = path.join(homeDir, 'code-project');
    await fs.mkdir(codeWorkspace, { recursive: true });
    await initWorkspaceRoot();
    await setWorkspaceRoot(codeWorkspace);

    const mw = createToolsMiddleware();
    const started = await listen((req, res) => {
      void mw(req, res, () => {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Not found' }));
      });
    });
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rmTestHome(homeDir);
  });

  test('createInProcessToolDispatch throws when cwd is omitted', () => {
    assert.throws(() => createInProcessToolDispatch({}), /cwd is required/);
    assert.throws(() => createInProcessToolDispatch({ cwd: '  ' }), /cwd is required/);
  });

  test('executeInProcessTool does not fall back to the workspace root', async () => {
    const out = await executeInProcessTool('list_directory', { path: '.' }, {});
    assert.equal(out.content, 'Error: cwd is required');
  });

  test('GET /api/tools/ping still works', async () => {
    const res = await fetch(`${baseUrl}/api/tools/ping`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { ok: true });
  });

  test('POST /api/tools list_directory still works', async () => {
    await fs.writeFile(path.join(codeWorkspace, 'ping-marker.txt'), 'ok\n', 'utf8');
    const httpOut = await postTools(baseUrl, {
      name: 'list_directory',
      args: { path: '.' },
      workspaceRoot: codeWorkspace,
    });
    assert.equal(httpOut.status, 200);
    assert.match(httpOut.json.result, /ping-marker\.txt/);

    const inProcess = await executeInProcessTool(
      'list_directory',
      { path: '.' },
      { cwd: codeWorkspace },
    );
    assert.equal(inProcess.content, httpOut.json.result);
  });

  test('host-kill-guard: identical rejection in-process vs HTTP', async () => {
    const command = 'taskkill /F /IM electron.exe /T';
    const httpOut = await postTools(baseUrl, {
      name: 'execute_command',
      args: { command },
      workspaceRoot: codeWorkspace,
    });
    assert.equal(httpOut.status, 200);
    assert.match(httpOut.json.result, /running Minnow app/);

    const inProcess = await executeInProcessTool(
      'execute_command',
      { command },
      { cwd: codeWorkspace },
    );
    assert.equal(inProcess.content, httpOut.json.result);
  });

  test('host-port-bind-guard: identical rejection in-process vs HTTP', async () => {
    const command = `npx vite --port ${livePort}`;
    const httpOut = await postTools(baseUrl, {
      name: 'execute_command',
      args: { command },
      workspaceRoot: codeWorkspace,
    });
    assert.equal(httpOut.status, 200);
    assert.match(httpOut.json.result, /refusing to run/);

    const inProcess = await executeInProcessTool(
      'execute_command',
      { command },
      { cwd: codeWorkspace },
    );
    assert.equal(inProcess.content, httpOut.json.result);
  });

  test(
    'windows-pipe-guard: identical rejection in-process vs HTTP',
    { skip: !isWin32 },
    async () => {
      const command = 'echo x | tail -5';
      const httpOut = await postTools(baseUrl, {
        name: 'execute_command',
        args: { command },
        workspaceRoot: codeWorkspace,
      });
      assert.equal(httpOut.status, 200);
      assert.match(httpOut.json.result, /`tail` isn't available under cmd\.exe/);

      const inProcess = await executeInProcessTool(
        'execute_command',
        { command },
        { cwd: codeWorkspace },
      );
      assert.equal(inProcess.content, httpOut.json.result);
    },
  );

  test('plan-write-guard: identical rejection in-process vs HTTP', async () => {
    const args = { path: 'src/foo.ts', content: 'x' };
    const httpOut = await postTools(baseUrl, {
      name: 'save_file',
      args,
      modeId: 'plan',
      workspaceRoot: codeWorkspace,
    });
    assert.equal(httpOut.status, 200);
    assert.match(httpOut.json.result, /documentation\/plans/);

    const inProcess = await executeInProcessTool('save_file', args, {
      cwd: codeWorkspace,
      modeId: 'plan',
    });
    assert.equal(inProcess.content, httpOut.json.result);
  });

  test('output-cap truncation matches HTTP byte for byte', async () => {
    // Line count is derived from the cap, not a literal: MIN-667 made the cap
    // configurable and raised the default 32k -> 128k, which left a fixed
    // 500-line fixture under the threshold and stopped testing truncation.
    const LINE_CHARS = 78;
    const lineCount = Math.ceil((DEFAULT_MAX_OUTPUT_CHARS * 2) / LINE_CHARS);
    const lines = Array.from(
      { length: lineCount },
      (_, i) => `line-${String(i + 1).padStart(3, '0')}-${'x'.repeat(70)}`,
    );
    const body = `${lines.join('\n')}\n`;
    assert.ok(body.length > DEFAULT_MAX_OUTPUT_CHARS);
    const rel = 'huge-output.txt';
    await fs.writeFile(path.join(codeWorkspace, rel), body, 'utf8');

    const httpOut = await postTools(baseUrl, {
      name: 'read_file',
      args: { path: rel },
      workspaceRoot: codeWorkspace,
    });
    assert.equal(httpOut.status, 200);
    assert.match(httpOut.json.result, /\[truncated —/);

    const inProcess = await executeInProcessTool(
      'read_file',
      { path: rel },
      { cwd: codeWorkspace },
    );
    assert.equal(inProcess.content, httpOut.json.result);
  });

  test('cwd isolation: attempt A cannot read or write attempt B', async () => {
    const trees = getWorktreesRoot();
    const dirA = path.join(trees, 'attempt-a');
    const dirB = path.join(trees, 'attempt-b');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(path.join(dirA, 'secret-a.txt'), 'AAA\n', 'utf8');
    await fs.writeFile(path.join(dirB, 'secret-b.txt'), 'BBB\n', 'utf8');

    const dispatchA = createInProcessToolDispatch({ cwd: dirA });

    const own = await dispatchA.execute('read_file', { path: 'secret-a.txt' });
    assert.match(own.content, /AAA/);

    const absLeak = await dispatchA.execute('read_file', {
      path: path.join(dirB, 'secret-b.txt'),
    });
    assert.match(absLeak.content, /outside the workspace/i);
    assert.doesNotMatch(absLeak.content, /BBB/);

    const relLeak = await dispatchA.execute('read_file', {
      path: path.join('..', 'attempt-b', 'secret-b.txt'),
    });
    assert.match(relLeak.content, /outside the workspace/i);

    const writeLeak = await dispatchA.execute('save_file', {
      path: path.join(dirB, 'pwned.txt'),
      content: 'nope',
    });
    assert.match(writeLeak.content, /outside the workspace/i);
    await assert.rejects(fs.access(path.join(dirB, 'pwned.txt')));
  });

  test('cwd-guard: leading cd into another root is rewritten', async () => {
    const trees = getWorktreesRoot();
    const dirA = path.join(trees, 'guard-a');
    const dirB = path.join(trees, 'guard-b');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(path.join(dirB, 'secret-b.txt'), 'LEAK\n', 'utf8');

    const dispatchA = createInProcessToolDispatch({ cwd: dirA });
    const command = `cd "${dirB}" && node -e "console.log(require('fs').readFileSync('secret-b.txt','utf8'))"`;
    const out = await dispatchA.execute('execute_command', { command });
    assert.doesNotMatch(out.content, /LEAK/);
  });

  test('runHeadlessToolBatch uses the closed-over execute', async () => {
    const dispatch = createInProcessToolDispatch({ cwd: codeWorkspace });
    const outcomes = await dispatch.runHeadlessToolBatch({
      toolCalls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'list_directory', arguments: '{"path":"."}' },
        },
      ],
    });
    assert.equal(outcomes.length, 1);
    assert.match(outcomes[0].result.content, /ping-marker\.txt/);
  });

  test('allowedToolNames rejects tools outside the subset', async () => {
    const dispatch = createInProcessToolDispatch({
      cwd: codeWorkspace,
      allowedToolNames: ['list_directory'],
    });
    const denied = await dispatch.execute('read_file', { path: 'ping-marker.txt' });
    assert.equal(denied.content, 'Error: tool "read_file" is not in the allowed set');
    const allowed = await dispatch.execute('list_directory', { path: '.' });
    assert.doesNotMatch(allowed.content, /not in the allowed set/);
  });

  test('in-process dispatch does not POST /api/tools', async () => {
    const orig = globalThis.fetch;
    let hits = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/tools')) hits += 1;
      return orig(input, init);
    };
    try {
      await executeInProcessTool(
        'list_directory',
        { path: '.' },
        { cwd: codeWorkspace },
      );
      assert.equal(hits, 0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test('default headless tool set contains no renderer-only tool', async () => {
    assert.deepEqual(rendererOnlyToolsIn(DEFAULT_HEADLESS_TOOL_IDS), []);
    for (const id of DEFAULT_HEADLESS_TOOL_IDS) {
      assert.equal(
        RENDERER_ONLY_TOOL_IDS.includes(id),
        false,
        `${id} is marked renderer-only`,
      );
    }

    const samples = [
      'get_datetime',
      'calculate',
      'ask_question',
      'spawn_sub_agent',
      'todo_write',
    ];
    for (const name of samples) {
      const out = await executeInProcessTool(name, {}, { cwd: codeWorkspace });
      assert.equal(out.content, `Not implemented: ${name}`);
    }

    // Default ids must be in the server registry (empty args may still Error).
    for (const id of DEFAULT_HEADLESS_TOOL_IDS) {
      if (id === 'run_impeccable') continue;
      const out = await executeInProcessTool(id, {}, { cwd: codeWorkspace });
      assert.equal(
        out.content.startsWith('Not implemented:'),
        false,
        `${id} is not a server handler: ${out.content.slice(0, 120)}`,
      );
    }
  });
});
