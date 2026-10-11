/**
 * Serve log tail + follow, and the HTTP routes that expose them.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequestNode } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { handleModelsRequest } from '../../server/models/routes.js';
import { modelsLogDir } from '../../server/models/paths.js';
import {
  MLX_LM_MANAGED_SERVER_ID,
  appendServeLog,
  readServeLogTail,
  readServeLogTailForServe,
  resolveServeLogPath,
  subscribeServeLog,
  subscribeServeLogForServe,
} from '../../server/models/serve-logs.js';
import { resetServesForTests } from '../../server/models/serve.js';

function httpRequest(baseUrl, method, pathname) {
  return new Promise((resolve, reject) => {
    const req = httpRequestNode(new URL(pathname, baseUrl), { method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = { raw };
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serve log tail', () => {
  /** @type {string} */
  let homeDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-serve-logs-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await fs.mkdir(modelsLogDir(), { recursive: true });
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('returns null when the run has no log yet', async () => {
    assert.equal(await readServeLogTail('missing-run'), null);
  });

  test('appendServeLog creates the spawn log so a fit planner warning is greppable', async () => {
    await appendServeLog(
      'run-fit-warn',
      'warning: you overrode the fit planner; estimate ~20 GB vs ~10 GB budget',
    );
    const tail = await readServeLogTail('run-fit-warn');
    assert.ok(tail);
    assert.match(tail.text, /fit planner/);
  });

  test('reads the trailing bytes of a log', async () => {
    const runId = 'run-tail';
    const logPath = path.join(modelsLogDir(), `${runId}.log`);
    await fs.writeFile(logPath, 'first line\nsecond line\n', 'utf8');

    const all = await readServeLogTail(runId);
    assert.ok(all);
    assert.match(all.text, /first line/);
    assert.equal(all.size, (await fs.stat(logPath)).size);

    const tail = await readServeLogTail(runId, 1024);
    assert.match(tail.text, /second line/);
  });

  test('follow replays existing output, then appended chunks', async () => {
    const runId = 'run-follow';
    const logPath = path.join(modelsLogDir(), `${runId}.log`);
    await fs.writeFile(logPath, 'boot\n', 'utf8');

    /** @type {Array<{ text: string, initial?: boolean }>} */
    const events = [];
    const done = new Promise((resolve) => {
      const unsub = subscribeServeLog(runId, (event) => {
        events.push(event);
        if (event.text.includes('boot')) {
          void fs.appendFile(logPath, 'loading 50.00 %\n', 'utf8');
          return;
        }
        if (event.text.includes('loading')) {
          unsub();
          resolve(undefined);
        }
      });
    });

    await done;
    assert.equal(events[0].initial, true);
    assert.match(events[1].text, /boot/);
    assert.match(events[2].text, /loading 50\.00 %/);
    assert.ok(!events[2].text.includes('boot'), 'follow-up chunks are deltas, not the whole file');
  });

  test('follow replays more than one chunk from the start without splitting UTF-8 tokens', async () => {
    const runId = 'run-full-history';
    const logPath = path.join(modelsLogDir(), `${runId}.log`);
    const output = 'boot\n' + 'x'.repeat(512 * 1024 - 6) + '€生成\nend\n';
    await fs.writeFile(logPath, output, 'utf8');
    const texts = [];
    let unsub;
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Full log replay timed out')), 3000);
        unsub = subscribeServeLog(runId, (event) => {
          texts.push(event.text);
          if (texts.join('').endsWith('end\n')) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      assert.equal(texts.join(''), output);
      assert.ok(texts.length >= 3, 'reset plus multiple bounded replay chunks');
    } finally {
      unsub?.();
    }
  });

  test('follow does not skip checkpoints after a dump larger than one read', async () => {
    // Qwen3.8 dumps tokenizer.ggml.tokens (~248k strings) before `loading model
    // tensors`. Returning EOF as the follow offset used to jump past that suffix.
    const runId = 'run-big-dump';
    const logPath = path.join(modelsLogDir(), `${runId}.log`);
    await fs.writeFile(logPath, 'boot\n', 'utf8');

    /** @type {string[]} */
    const texts = [];
    const unsub = subscribeServeLog(runId, (event) => {
      texts.push(event.text ?? '');
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const dump = Buffer.concat([
      Buffer.alloc(600 * 1024, 0x78),
      Buffer.from('\nload_tensors: loading model tensors\nserver is listening\n'),
    ]);
    await fs.appendFile(logPath, dump);
    await new Promise((resolve) => setTimeout(resolve, 800));
    unsub();

    const joined = texts.join('');
    assert.match(joined, /loading model tensors/);
    assert.match(joined, /server is listening/);
  });

  test('MLX serves resolve to the managed mlx-lm server log', async () => {
    const mlxLogPath = resolveServeLogPath({ runtime: 'mlx-lm', runId: null });
    assert.ok(mlxLogPath?.includes('mlx-lm.log'));
    await fs.mkdir(path.dirname(mlxLogPath), { recursive: true });
    await fs.writeFile(mlxLogPath, 'mlx server boot\n', 'utf8');

    const tail = await readServeLogTailForServe({ runtime: 'mlx-lm' });
    assert.ok(tail);
    assert.match(tail.text, /mlx server boot/);
    assert.equal(tail.size, (await fs.stat(mlxLogPath)).size);
    assert.equal(resolveServeLogPath({ runtime: 'llama-cpp' }), null);
    assert.equal(MLX_LM_MANAGED_SERVER_ID, 'mlx-lm');
  });

  test('follow waits until the serve gets a runId, then emits that log', async () => {
    // Local Server opens /logs/stream on commitServes('llama-starting'), which
    // is before createBackgroundRun assigns runId. A snapshot follow stayed empty.
    const serve = { runtime: 'llama-cpp', runId: null };
    /** @type {Array<{ text: string, initial?: boolean }>} */
    const events = [];
    const unsub = subscribeServeLogForServe(serve, (event) => {
      events.push(event);
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(events.length, 0, 'must not emit a fake empty tail before spawn');

    serve.runId = 'run-late-id';
    const logPath = path.join(modelsLogDir(), 'run-late-id.log');
    await fs.writeFile(logPath, 'print_info: starting llama-server\n', 'utf8');

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !events.some((e) => (e.text ?? '').includes('llama-server'))) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    unsub();

    const joined = events.map((e) => e.text ?? '').join('');
    assert.match(joined, /starting llama-server/);
    assert.equal(events[0].initial, true);
  });

  test('follow switches files when runId changes after a spawn retry', async () => {
    const firstPath = path.join(modelsLogDir(), 'run-retry-a.log');
    const secondPath = path.join(modelsLogDir(), 'run-retry-b.log');
    await fs.writeFile(firstPath, 'first spawn died\n', 'utf8');

    const serve = { runtime: 'llama-cpp', runId: 'run-retry-a' };
    /** @type {string[]} */
    const texts = [];
    const unsub = subscribeServeLogForServe(
      () => serve,
      (event) => {
        texts.push(event.text ?? '');
      },
    );

    const sawFirst = Date.now() + 2000;
    while (Date.now() < sawFirst && !texts.join('').includes('first spawn died')) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.match(texts.join(''), /first spawn died/);

    serve.runId = 'run-retry-b';
    await fs.writeFile(secondPath, 'second spawn listening\n', 'utf8');

    const sawSecond = Date.now() + 2000;
    while (Date.now() < sawSecond && !texts.join('').includes('second spawn listening')) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    unsub();

    assert.match(texts.join(''), /second spawn listening/);
  });
});

describe('serve log routes', () => {
  /** @type {string} */
  let homeDir;
  /** @type {import('node:http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-serve-routes-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await resetServesForTests();

    server = createServer(async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const handled = await handleModelsRequest(req, res, pathname);
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('single-serve GET 404s for an unknown id', async () => {
    const res = await httpRequest(
      baseUrl,
      'GET',
      '/api/models/serve/00000000-0000-4000-8000-000000000000',
    );
    assert.equal(res.status, 404);
  });

  test('single-serve GET rejects a malformed id', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/models/serve/not-a-uuid');
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Invalid/i);
  });

  test('log route 404s for an unknown serve', async () => {
    const res = await httpRequest(
      baseUrl,
      'GET',
      '/api/models/serve/00000000-0000-4000-8000-000000000000/logs',
    );
    assert.equal(res.status, 404);
  });
});
