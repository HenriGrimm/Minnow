import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { WebSocket } from 'ws';
import { addCredential, createDevice, revokeCredential, revokeDevice } from '../../server/auth/device-store.js';

test('revocation disconnects open PTYs for only the affected credential or device', {timeout: 10000}, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-revoke-ws-'));
  const previous = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home;
  const writes = [];
  mock.module('../../server/terminal/pty-host.js', { namedExports: {
    getPtySession: () => ({shell: 'fixture'}),
    subscribePtySession: () => () => {},
    writePtySession: (_id, data) => writes.push(data),
    resizePtySession() {}, destroyPtySession() {},
  }});
  const { attachPtyWebSocketServer } = await import('../../server/terminal/pty-ws.js');
  const server = http.createServer();
  const bridge = attachPtyWebSocketServer(server);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    bridge.close();
    server.close();
    if (previous === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  async function connect(deviceId) {
    const { token, credential } = addCredential(deviceId);
    const url = 'ws://127.0.0.1:' + server.address().port + '/api/terminal/ws?sessionId=fixture&token=' + token;
    const client = new WebSocket(url);
    clients.push(client);
    await once(client, 'message');
    return {client, credential};
  }
  const { device } = createDevice({name:'phone'});
  const first = await connect(device.id);
  const second = await connect(device.id);
  const other = await connect(createDevice({name:'tablet'}).device.id);
  const closed = once(first.client, 'close');
  assert.ok(revokeCredential(device.id, first.credential.id));
  await closed;
  assert.equal(second.client.readyState, WebSocket.OPEN);
  const alsoClosed = once(second.client, 'close');
  assert.ok(revokeDevice(device.id));
  await alsoClosed;
  other.client.send(JSON.stringify({type:'input', data:'still connected'}));
  const pong = once(other.client, 'pong');
  other.client.ping('barrier');
  await pong;
  assert.deepEqual(writes, ['still connected']);
});
