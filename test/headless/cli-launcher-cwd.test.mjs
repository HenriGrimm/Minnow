/**
 * Regression test for MIN-52: `bin/minnow.mjs` must launch the headless CLI
 * child with the caller's cwd, not the Minnow install directory, so that
 * `--workspace .` resolves against the caller's project.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

describe('cli launcher cwd', () => {
  let server = null;
  let base = '';
  let callerDir = '';
  let tempHome = '';
  let workspaceOpenBody = null;
  let workspaceOpenScope;
  let runWorkspaceScope;

  before(async () => {
    callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-caller-'));
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-home-'));

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/config/ping' && req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/api/tools/ping' && req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/api/workspace/open' && req.method === 'POST') {
        workspaceOpenScope = req.headers['x-minnow-workspace'];
        // A fresh folder is not allowed as a request scope until registered.
        if (workspaceOpenScope) {
          res.writeHead(400).end(JSON.stringify({ error: `Unknown workspace: ${workspaceOpenScope}` }));
          return;
        }
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          try {
            workspaceOpenBody = JSON.parse(raw);
          } catch {
            workspaceOpenBody = null;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      runWorkspaceScope = req.headers['x-minnow-workspace'];
      res.statusCode = 500;
      res.end('not found');
    });

    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (typeof server?.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server?.close((err) => (err ? reject(err) : resolve()));
    });
    fs.rmSync(callerDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('registers the caller cwd, not the Minnow install directory', { timeout: 60000 }, async () => {
    // Note: uses async spawn, not spawnSync — spawnSync would block this
    // process's event loop, so the in-process http server above could never
    // answer the child's pings, deadlocking the run.
    const child = spawn(
      process.execPath,
      [
        path.join(repoRoot, 'bin', 'minnow.mjs'),
        'run',
        '--prompt',
        'noop',
        '--workspace',
        '.',
        '--base-url',
        base,
        '--token',
        'test',
        '--json',
      ],
      {
        cwd: callerDir,
        env: { ...process.env, MINNOW_HOME: tempHome, BROWSER: 'none' },
      },
    );
    await new Promise((resolve) => {
      child.on('exit', resolve);
      child.on('error', resolve);
    });

    assert.ok(workspaceOpenBody, 'expected /api/workspace/open to be called');
    assert.equal(workspaceOpenScope, undefined, 'registration must precede workspace scoping');
    const expected = fs.realpathSync(callerDir);
    assert.equal(workspaceOpenBody.path, expected);
    assert.equal(runWorkspaceScope, expected, 'subsequent run requests must target the registered workspace');
    assert.notEqual(workspaceOpenBody.path, fs.realpathSync(repoRoot));
  });
});
