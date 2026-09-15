/**
 * TTS stream client protocol parsing tests.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  parseTtsServerMessage,
  buildTtsWsUrl,
  TtsStreamClient,
} from '../../src/voice/tts-stream-client.ts';

describe('tts-stream-client', () => {
  test('unexpected closure after ready reports failure; final and cancellation do not', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalWs = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    let socket: any;
    class Socket {
      static OPEN = 1;
      readyState = 1;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      constructor() { socket = this; }
      send() {}
      close() { this.onclose?.(); }
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      location: { protocol: 'http:', host: 'localhost:5173' },
    } });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    try {
      for (const ending of ['unexpected', 'final', 'cancel']) {
        const errors: string[] = [];
        const client = new TtsStreamClient({ onError: (error) => errors.push(error) });
        const started = client.start('Hello');
        socket.onmessage({ data: JSON.stringify({ type: 'ready', sampleRate: 24000 }) });
        await started;
        if (ending === 'final') socket.onmessage({ data: JSON.stringify({ type: 'final' }) });
        else if (ending === 'cancel') client.cancel();
        else socket.close();
        assert.equal(errors.length, ending === 'unexpected' ? 1 : 0);
        client.close();
      }
    } finally {
      for (const [key, descriptor] of [['window', originalWindow], ['WebSocket', originalWs]] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test('parseTtsServerMessage accepts ready, final, and error', () => {
    assert.deepEqual(
      parseTtsServerMessage(JSON.stringify({ type: 'ready', sampleRate: 24000 })),
      { type: 'ready', sampleRate: 24000 },
    );
    assert.deepEqual(parseTtsServerMessage(JSON.stringify({ type: 'final' })), {
      type: 'final',
    });
    assert.deepEqual(
      parseTtsServerMessage(JSON.stringify({ type: 'final', durationMs: 1200 })),
      { type: 'final', durationMs: 1200 },
    );
    assert.deepEqual(
      parseTtsServerMessage(JSON.stringify({ type: 'error', message: 'fail' })),
      { type: 'error', message: 'fail' },
    );
  });

  test('parseTtsServerMessage rejects unknown or malformed payloads', () => {
    assert.equal(parseTtsServerMessage('not json'), null);
    assert.equal(parseTtsServerMessage(JSON.stringify({ type: 'ready' })), null);
    assert.equal(parseTtsServerMessage(JSON.stringify({ type: 'segment', text: 'x' })), null);
  });

  test('buildTtsWsUrl targets /api/tts/ws on current host', () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { protocol: 'http:', host: 'localhost:5173' },
      },
    });
    try {
      assert.equal(buildTtsWsUrl(), 'ws://localhost:5173/api/tts/ws');
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});
