import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  resetGodotSessionsForTest,
  setGodotControllerHooksForTest,
} from '../../server/godot/controller.js';
import { godotDebugRequest, resetGodotDebugForTest, startGodotDebug } from '../../server/godot/dap-client.js';
import { invalidateLspConfigCache } from '../../server/lsp/config-loader.js';
import { getLspHover, shutdownAllLsp } from '../../server/lsp/manager.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';

describe('Godot TCP LSP transport', () => {
  let workspace;
  let home;
  let tcpServer;
  let dapServer;

  before(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-godot-lsp-'));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-godot-lsp-home-'));
    await fs.writeFile(path.join(workspace, 'project.godot'), '[application]\nconfig/name="TCP Test"\n');
    await fs.writeFile(path.join(workspace, 'player.gd'), 'extends Node\n');
    await fs.writeFile(path.join(home, 'lsp.json'), JSON.stringify({
      enabled: true,
      lsp: { godot: { disabled: false } },
    }));
    process.env.MINNOW_HOME = home;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    await setWorkspaceRoot(workspace);

    setGodotControllerHooksForTest({
      findExecutable: async () => ({ path: 'fake-godot', source: 'test' }),
      probeExecutable: async () => ({ ok: true, version: { major: 4, minor: 6, patch: 1 } }),
      spawn: (_executable, args) => {
        const port = Number(args[args.indexOf('--lsp-port') + 1]);
        const dapPort = Number(args[args.indexOf('--dap-port') + 1]);
        const child = new EventEmitter();
        child.pid = 4242;
        child.exitCode = null;
        child.killed = false;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
          child.killed = true;
          child.exitCode = 0;
          child.emit('exit', 0, null);
        };
        tcpServer = net.createServer((socket) => {
          const connection = createMessageConnection(
            new StreamMessageReader(socket),
            new StreamMessageWriter(socket),
          );
          connection.onRequest('initialize', () => ({
            capabilities: { hoverProvider: true, textDocumentSync: 1 },
          }));
          connection.onRequest('textDocument/hover', () => ({
            contents: { kind: 'markdown', value: '**Godot TCP hover**' },
          }));
          connection.listen();
        });
        tcpServer.listen(port, '127.0.0.1');
        dapServer = net.createServer((socket) => {
          let buffer = Buffer.alloc(0);
          let sequence = 1;
          socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (true) {
              const headerEnd = buffer.indexOf('\r\n\r\n');
              if (headerEnd < 0) return;
              const header = buffer.subarray(0, headerEnd).toString('ascii');
              const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
              if (buffer.length < headerEnd + 4 + length) return;
              const request = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length));
              buffer = buffer.subarray(headerEnd + 4 + length);
              const body = request.command === 'threads'
                ? { threads: [{ id: 1, name: 'Main Thread' }] }
                : request.command === 'initialize'
                  ? { supportsConfigurationDoneRequest: true }
                  : {};
              const response = JSON.stringify({
                seq: sequence++, type: 'response', request_seq: request.seq,
                success: true, command: request.command, body,
              });
              socket.write(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`);
            }
          });
        });
        dapServer.listen(dapPort, '127.0.0.1');
        return child;
      },
    });
  });

  after(async () => {
    shutdownAllLsp();
    resetGodotDebugForTest();
    resetGodotSessionsForTest();
    await new Promise((resolve) => tcpServer?.close(() => resolve()));
    await new Promise((resolve) => dapServer?.close(() => resolve()));
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  test('uses the standard hover bridge over the managed Godot socket', async () => {
    const result = await getLspHover('player.gd', 0, 2);
    assert.equal(result.error, undefined);
    assert.equal(result.hover.contents.value, '**Godot TCP hover**');
  });

  test('drives the Godot DAP endpoint through the shared project session', async () => {
    const started = await startGodotDebug(workspace);
    assert.equal(started.capabilities.supportsConfigurationDoneRequest, true);
    const threads = await godotDebugRequest(workspace, { action: 'threads' });
    assert.deepEqual(threads.threads, [{ id: 1, name: 'Main Thread' }]);
    await godotDebugRequest(workspace, { action: 'stop' });
  });
});
