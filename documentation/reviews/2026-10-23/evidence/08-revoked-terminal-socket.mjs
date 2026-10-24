// Run: node --experimental-test-module-mocks documentation/reviews/2026-10-23/evidence/08-revoked-terminal-socket.mjs
// Uses a mocked PTY and a fresh temporary home. No real shell command executes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { mock } from 'node:test';
import WebSocket from 'ws';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-review-revoke-'));
const priorHome = process.env.MINNOW_HOME; process.env.MINNOW_HOME = home;
const writes = [];
mock.module(new URL('../../../../server/terminal/pty-host.js', import.meta.url).href, {
  namedExports: {
    getPtySession: () => ({ shell: 'mock', shellProfileId: 'mock', scrollback: '' }),
    subscribePtySession: () => () => {},
    writePtySession: (_id, data) => writes.push(data),
    resizePtySession: () => {},
    destroyPtySession: () => {},
  },
});
let server, socket;
try {
  const { createDevice, addCredential, revokeDevice, authenticateDeviceToken } = await import('../../../../server/auth/device-store.js');
  const { attachPtyWebSocketServer } = await import('../../../../server/terminal/pty-ws.js');
  const { device } = createDevice({ name: 'Synthetic review device', kind: 'phone' });
  const issued = addCredential(device.id, { label: 'review' });
  server = http.createServer(); attachPtyWebSocketServer(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  socket = new WebSocket('ws://127.0.0.1:' + server.address().port + '/api/terminal/ws?sessionId=synthetic', { headers: { 'X-Minnow-Token': issued.token } });
  await once(socket, 'open');
  revokeDevice(device.id);
  const httpCredentialNowValid = Boolean(authenticateDeviceToken(issued.token));
  socket.send(JSON.stringify({ type: 'input', data: 'synthetic-input' }));
  await new Promise(resolve => setTimeout(resolve, 50));
  console.log(JSON.stringify({ httpCredentialNowValid, terminalWritesAfterRevocation: writes.length }));
  assert.equal(writes.length, 0, 'Revocation must stop input from already-open terminal sockets');
} finally {
  socket?.terminate(); server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  mock.restoreAll();
  if (priorHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = priorHome;
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(home, { recursive: true, force: true });
}

