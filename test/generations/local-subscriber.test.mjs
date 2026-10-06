/**
 * In-process generation subscribers: callback fan-out beside HTTP sockets.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  addLocalSubscriber,
  addSubscriber,
  appendChunk,
  createGenerationState,
  deleteGenerationsForProviderShutdown,
  markComplete,
  markError,
} from '../../server/generations/store.js';

afterEach(() => {
  deleteGenerationsForProviderShutdown();
});

function createHttpResponse() {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    writableEnded: false,
    destroyed: false,
    /** @type {Buffer[]} */
    parts: [],
    write(buf) {
      this.parts.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
    },
  });
}

describe('generations store in-process subscribers', () => {
  it('replays buffered chunks then live ones, then a structured end', () => {
    const state = createGenerationState({ providerId: 'p', body: {} });
    appendChunk(state, Buffer.from('one', 'utf8'));

    /** @type {string[]} */
    const chunks = [];
    /** @type {object | null} */
    let end = null;
    addLocalSubscriber(state, {
      onChunk(buf) {
        chunks.push(buf.toString('utf8'));
      },
      onEnd(payload) {
        end = payload;
      },
    });

    assert.deepEqual(chunks, ['one']);
    appendChunk(state, Buffer.from('two', 'utf8'));
    assert.deepEqual(chunks, ['one', 'two']);

    markComplete(state);
    assert.equal(end?.status, 'complete');
  });

  it('allows a generation to stream beyond 16 MiB and finish', () => {
    const state = createGenerationState({ providerId: 'p', body: {} });
    const controller = new AbortController();
    state.upstreamController = controller;
    const chunk = Buffer.alloc(1024 * 1024, 97);

    for (let i = 0; i < 17; i += 1) appendChunk(state, chunk);

    assert.equal(state.totalBytes, 17 * 1024 * 1024);
    assert.equal(state.status, 'streaming');
    assert.equal(controller.signal.aborted, false);
    markComplete(state);
    assert.equal(state.status, 'complete');
  });

  it('does not write the HTTP end sentinel to local subscribers', () => {
    const state = createGenerationState({ providerId: 'p', body: {} });
    /** @type {string[]} */
    const chunks = [];
    addLocalSubscriber(state, {
      onChunk(buf) {
        chunks.push(buf.toString('utf8'));
      },
      onEnd() {},
    });
    appendChunk(state, Buffer.from('data: {"x":1}\n\n', 'utf8'));
    markComplete(state);
    assert.equal(chunks.some((c) => c.includes('event: end')), false);
  });

  it('HTTP subscribers still receive bytes when a local subscriber is attached', () => {
    const state = createGenerationState({ providerId: 'p', body: {} });
    const res = createHttpResponse();
    addSubscriber(state, res);

    /** @type {string[]} */
    const local = [];
    addLocalSubscriber(state, {
      onChunk(buf) {
        local.push(buf.toString('utf8'));
      },
      onEnd() {},
    });

    appendChunk(state, Buffer.from('alpha', 'utf8'));
    assert.equal(Buffer.concat(res.parts).toString('utf8'), 'alpha');
    assert.deepEqual(local, ['alpha']);
  });

  it('already-terminal generations deliver onEnd without staying subscribed', () => {
    const state = createGenerationState({ providerId: 'p', body: {} });
    markError(state, 'upstream boom');
    /** @type {object | null} */
    let end = null;
    const unsub = addLocalSubscriber(state, {
      onChunk() {},
      onEnd(payload) {
        end = payload;
      },
    });
    assert.equal(end?.status, 'error');
    assert.equal(end?.errorMessage, 'upstream boom');
    unsub();
  });
});
