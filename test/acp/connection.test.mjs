import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  __acpConnectionInternals,
  initializeAcpConnection,
  spawnAcpConnection,
} from '../../server/acp/connection.js';

const fixture = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url));

test('ACP stdio client negotiates, starts a session, streams text, and prompts', async () => {
  const updates = [];
  const connection = spawnAcpConnection({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    env: { ACP_FIXTURE_TOKEN: 'private-value' },
    onNotification: (method, params) => updates.push({ method, params }),
  });
  try {
    const initialized = await initializeAcpConnection(connection);
    assert.equal(initialized.protocolVersion, 1);
    assert.equal(initialized.agentInfo.name, 'Fixture ACP');
    const session = await connection.request('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const response = await connection.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    assert.equal(response.stopReason, 'end_turn');
    assert.equal(updates[0].method, 'session/update');
    assert.equal(updates[0].params.update.content.text, 'Echo: hello');
  } finally {
    await connection.stop();
  }
});

test('ACP client rejects an unsupported negotiated protocol version', async () => {
  const connection = spawnAcpConnection({
    command: process.execPath,
    args: [fixture, '--bad-version'],
    cwd: process.cwd(),
  });
  try {
    await assert.rejects(() => initializeAcpConnection(connection), /Unsupported ACP protocol version 99/);
  } finally {
    await connection.stop();
  }
});

test('ACP diagnostics redact even short private environment values', () => {
  assert.equal(__acpConnectionInternals.redact('secret=x', ['x']), 'secret=[redacted]');
});
