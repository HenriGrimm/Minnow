import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { importMcpServers, listServers, listEnabledMcpTools, callMcpTool, reloadMcp, setMcpServerEnabled } from '../../server/mcp/registry.js';
import { validateMcpImport } from '../../server/mcp/validate.js';

test('standard examples, verbatim arguments, and atomic validation', () => {
  const entries = validateMcpImport({ mcpServers: {
    'cloudflare-api': { url: '[https://mcp.cloudflare.com/mcp](https://mcp.cloudflare.com/mcp)' },
    linear: { command: 'npx', args: ['-y', 'mcp-remote', '[https://mcp.linear.app/mcp](https://mcp.linear.app/mcp)', '', ' padded '] },
  } });
  assert.equal(entries[0].transport.url, 'https://mcp.cloudflare.com/mcp');
  assert.deepEqual(entries[1].transport.args, ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp', '', ' padded ']);
  assert.throws(() => validateMcpImport({ mcpServers: { '../escape': { command: 'node' } } }), /Invalid/);
  assert.throws(() => validateMcpImport({ mcpServers: { bad: { url: 'file:///x' } } }), /Invalid/);
  assert.throws(() => validateMcpImport({ mcpServers: { bad: { command: 'node', args: 'a b' } } }), /Invalid/);
});
test('HTTP OAuth discovery, callback state, encrypted tokens, pagination, and disabled dispatch', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-mcp-'));
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  let base;
  let registration;
  let exchanges = 0;
  let calls = 0;
  let refreshed = false;
  let expire = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    }
    if (url.pathname === '/register') {
      registration = JSON.parse(raw);
      return json({ ...registration, client_id: 'test-client' }, 201);
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(raw);
      if (params.get('grant_type') === 'refresh_token') {
        assert.equal(params.get('refresh_token'), 'private-refresh-token');
        refreshed = true;
        expire = false;
        return json({ access_token: 'private-access-token', refresh_token: 'private-refresh-token', token_type: 'Bearer', expires_in: 3600 });
      }
      assert.equal(params.get('code'), 'valid-code');
      assert.ok(params.get('code_verifier'));
      exchanges++;
      return json({ access_token: 'private-access-token', refresh_token: 'private-refresh-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.pathname !== '/mcp') return json({}, 404);
    if (req.headers.authorization !== 'Bearer private-access-token' || expire) {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
      return json({}, 401);
    }
    if (req.method === 'GET') return json({}, 405);
    const request = JSON.parse(raw);
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    else if (request.method === 'tools/list') result = request.params?.cursor
      ? { tools: [{ name: 'second', inputSchema: { type: 'object' } }] }
      : { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'page2' };
    else if (request.method === 'tools/call') { calls++; result = { content: [{ type: 'text', text: 'remote result' }] }; }
    return json({ jsonrpc: '2.0', id: request.id, result });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    // A standard-only on-disk file works without Minnow's legacy index.
    await fs.writeFile(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { remote: { url: `${base}/mcp` } } }));
    await listEnabledMcpTools();
    const pending = (await listServers()).find(s => s.id === 'remote');
    assert.ok(pending.authorizationUrl);
    const auth = new URL(pending.authorizationUrl);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('redirect_uri'), registration.redirect_uris[0]);
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'valid-code');
    callback.searchParams.set('state', 'wrong');
    assert.equal((await fetch(callback)).status, 400);
    assert.equal(exchanges, 0);
    callback.searchParams.set('state', auth.searchParams.get('state'));
    assert.equal((await fetch(callback)).status, 200);
    const defs = await listEnabledMcpTools();
    assert.ok(defs.some(d => d.function.name === 'mcp__remote__second'));
    assert.equal(await callMcpTool('mcp__remote__second', {}), 'remote result');
    assert.equal(calls, 1);
    const secretFiles = await fs.readdir(path.join(home, 'mcp/oauth'));
    const saved = await fs.readFile(path.join(home, 'mcp/oauth', secretFiles[0]), 'utf8');
    assert.ok(!saved.includes('private-access-token'));
    await reloadMcp();
    expire = true;
    assert.equal(await callMcpTool('mcp__remote__first', {}), 'remote result');
    assert.equal(refreshed, true, 'expired tokens refresh without another login');
    assert.equal(exchanges, 1, 'restart reuses encrypted OAuth tokens');
    await setMcpServerEnabled('remote', false);
    assert.match(await callMcpTool('mcp__remote__first', {}), /disabled/);
    assert.equal(calls, 2);
    const before = await fs.readFile(path.join(home, 'mcp.json'), 'utf8');
    await assert.rejects(importMcpServers({ mcpServers: { valid: { command: 'node' }, bad: { args: [] } } }));
    assert.equal(await fs.readFile(path.join(home, 'mcp.json'), 'utf8'), before);
  } finally {
    await reloadMcp();
    await new Promise(resolve => server.close(resolve));
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true });
  }
});

