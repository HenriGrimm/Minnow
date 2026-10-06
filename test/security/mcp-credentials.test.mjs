import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMcpConnection, authenticateMcpToken, revokeMcpConnection, listMcpConnections } from '../../server/auth/mcp-store.js';
import { authenticateMinnowToken } from '../../server/runtime/authenticate-token.js';
import { describeHubStdio } from '../../server/mcp-hub/middleware.js';

test('MCP credentials persist across processes, fail closed and bind to canonical workspace paths', t => {
  const previousHome = process.env.MINNOW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-mcp-credentials-'));
  process.env.MINNOW_HOME = home;
  const workspace = path.join(home, 'project');
  const other = path.join(home, 'other');
  fs.mkdirSync(workspace);
  fs.mkdirSync(other);
  t.after(() => {
    if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const { token, connection } = createMcpConnection({ name: 'External reader', workspace, access: 'read' });
  assert.equal(authenticateMinnowToken(token), null, 'global APIs and WebSockets never accept an MCP token');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { authenticateMcpToken } from './server/auth/mcp-store.js'; const auth = authenticateMcpToken(process.env.TEST_MCP_TOKEN, process.env.TEST_MCP_WORKSPACE); if (auth?.kind !== 'mcp' || !auth.readOnly) process.exit(1);"],
    { env: { ...process.env, TEST_MCP_TOKEN: token, TEST_MCP_WORKSPACE: workspace }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(listMcpConnections(workspace)[0].lastUsedAt);
  assert.equal(authenticateMcpToken(token, other), null);
  assert.equal(authenticateMcpToken(`${token.slice(0, -1)}!`, workspace), null);
  assert.equal(authenticateMcpToken('x'.repeat(100000), workspace), null);
  const alias = path.join(home, 'alias');
  fs.symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(authenticateMcpToken(token, alias)?.readOnly, true);
  fs.unlinkSync(alias);
  fs.symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(authenticateMcpToken(token, alias), null, 'retargeting a workspace alias does not move the credential');
  fs.unlinkSync(alias);
  assert.equal(revokeMcpConnection(connection.id, other), false);
  assert.equal(revokeMcpConnection(connection.id, workspace), true);
  assert.equal(authenticateMcpToken(token, workspace), null);
  const agent = createMcpConnection({ name: 'Agent workspace', access: 'read' });
  assert.equal(agent.connection.workspace, null);
  assert.equal(authenticateMcpToken(agent.token)?.readOnly, true);
  assert.equal(authenticateMcpToken(agent.token, other)?.readOnly, true);
  assert.equal(authenticateMinnowToken(agent.token), null);
  const rotated = createMcpConnection({ replaceId: agent.connection.id, workspace: other, access: 'write' });
  assert.equal(rotated.connection.workspace, null);
  assert.equal(rotated.connection.access, 'read');
  assert.equal(authenticateMcpToken(agent.token), null);
  assert.equal(authenticateMcpToken(rotated.token)?.readOnly, true);
  assert.ok(listMcpConnections().some(row => row.id === rotated.connection.id));
  assert.equal(revokeMcpConnection(rotated.connection.id), true);
  assert.equal(authenticateMcpToken(rotated.token), null);
  const next = createMcpConnection({ name: 'Next', workspace, access: 'write' });
  fs.writeFileSync(path.join(home, 'auth', 'mcp-connections.json'), '{"version":1,"connections":[{}]}');
  assert.throws(() => authenticateMcpToken(next.token, workspace), /Invalid MCP connection store/);
});

test('stdio availability explains packaged and missing bridges, including Windows ASAR paths', () => {
  for (const cliPath of [null, 'C:\\Minnow\\resources\\app.asar\\bin\\minnow.mjs', '/opt/minnow/app.asar/bin/minnow.mjs']) {
    const info = describeHubStdio(cliPath);
    assert.equal(info.stdio, null);
    assert.match(info.stdioUnavailableReason, /source checkout.*Node.js/);
  }
  assert.equal(describeHubStdio('/src/Minnow/bin/minnow.mjs').stdio.command, 'node');
  assert.ok(describeHubStdio('/opt/app.asar.unpacked/bin/minnow.mjs').stdio);
});
