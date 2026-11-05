import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import connect from 'connect';
import sirv from 'sirv';
import { createAgentBrowserMiddleware, executeAgentBrowserTool, registerAgentBrowserRuntime, shutdownAgentBrowserService } from '../../server/browser-agent-api.js';
import { attachNativeBrowserHost } from '../../server/agent-browser/native-transport.js';
import { createSpaAuthHtmlMiddleware } from '../../server/runtime/spa-auth-html.js';
import { attachStreamWebSocketServer } from '../../server/runtime/stream-ws.js';
import { resolveRequestAuth } from '../../server/runtime/request-auth.js';
import { getSessionToken } from '../../server/runtime/session-token.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';

test('built viewer uses the live tab, selects without clicking and acknowledges the exact Guide',
  { skip: process.env.MINNOW_TEST_NATIVE_VIEWER !== '1', timeout: 90000 }, async t => {
    const root = setTestHome(process.env, 'minnow-native-viewer');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ browser: { nativeAgentTabs: true } }));
    getSessionToken();
    const app = connect();
    let frames = 0;
    app.use((req, res, next) => {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) return next();
      const access = resolveRequestAuth(req, url);
      if (!access.ok) { res.writeHead(access.status).end(); return; }
      if (url.pathname.endsWith('/frame')) frames++;
      if (url.pathname.startsWith('/api/browser-agent/')) return next();
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
    app.use(createAgentBrowserMiddleware());
    app.use(createSpaAuthHtmlMiddleware({ indexPath: path.resolve('dist/index.html') }));
    app.use(sirv(path.resolve('dist')));
    const server = http.createServer(app);
    attachNativeBrowserHost(server);
    attachStreamWebSocketServer(server);
    const site = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<button onclick="document.title=\'clicked\'">Select fixture</button><input aria-label="Name">');
    });
    for (const listener of [server, site]) { listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); }
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const { default: electronPath } = await import('electron');
    const env = { ...process.env, MINNOW_SMOKE_BASE: baseUrl };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(electronPath, ['test/fixtures/native-agent-viewer.mjs'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = once(child, 'exit');
    const watchdog = setTimeout(() => {
      console.error('Viewer watchdog:', output.slice(-1500));
      child.kill();
    }, 35000);
    t.after(async () => {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      await shutdownAgentBrowserService();
      for (const listener of [server, site]) { listener.closeAllConnections(); listener.close(); }
      closeSessionsDb();
      await rmTestHome(root);
    });
    const owner = { chatId: 'viewer', agentId: 'builder', runId: 'turn' };
    const runtime = await registerAgentBrowserRuntime(owner);
    const waitMarker = async marker => {
      const start = Date.now();
      while (!output.includes('VIEWER ' + marker)) {
        if (child.exitCode !== null || Date.now() - start > 25000) throw new Error('Waiting for ' + marker + ': ' + output);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    await waitMarker('ready');
    console.log('Built viewer loaded');
    const reserved = await executeAgentBrowserTool('browser_reserve_tab', { url: 'http://127.0.0.1:' + site.address().port }, { runtimeOwner: owner });
    assert.match(reserved.result, /Reserved agent browser tab/);
    console.log('Agent reserved a browser tab');
    await waitMarker('sent');
    const [guide] = runtime.drainGuides();
    assert.equal(guide.message, 'Inspect the fixture button');
    assert.match(guide.elementSummary, /Select fixture/);
    assert.equal((await exited)[0], 0, output);
    assert.equal(frames, 0);
  });
