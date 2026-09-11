import assert from 'node:assert/strict';
import { test } from 'node:test';

 test('detached Models receives ongoing progress and clears only the owning window', async () => {
  const peers = new Set();
  class Channel {
    onmessage = null;
    constructor() { peers.add(this); }
    postMessage(data) {
      for (const peer of peers) if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data }));
    }
    close() { peers.delete(this); }
  }
  const oldWindow = globalThis.window;
  const oldChannel = globalThis.BroadcastChannel;
  const closes = [];
  globalThis.window = { addEventListener: (_name, fn) => closes.push(fn) };
  globalThis.BroadcastChannel = Channel;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    const owner = await import('../../src/models/in-flight-prompt.ts?owner');
    const progress = { serveId: 's', libraryId: 'm', modelLabel: 'm', processed: 5, total: 10, cache: 0, predictedN: 0 };
    owner.setInFlightPromptOverlay(progress);
    const detached = await import('../../src/models/in-flight-prompt.ts?detached');
    let notifications = 0;
    const unsub = detached.subscribeInFlightPromptOverlay(() => notifications++);
    await flush();
    assert.deepEqual(detached.getInFlightPromptOverlay(), progress);
    detached.clearInFlightPromptOverlay();
    await flush();
    assert.deepEqual(owner.getInFlightPromptOverlay(), progress);
    owner.setInFlightPromptOverlay({ ...progress, processed: 10, predictedN: 42 });
    await flush();
    assert.equal(detached.getInFlightPromptOverlay().predictedN, 42);
    owner.clearInFlightPromptOverlay();
    await flush();
    assert.equal(detached.getInFlightPromptOverlay(), null);
    assert.equal(notifications, 3);
    owner.setInFlightPromptOverlay(progress);
    await flush();
    closes[0]();
    await flush();
    assert.equal(detached.getInFlightPromptOverlay(), null);
    unsub();
  } finally {
    for (const close of closes) close();
    globalThis.window = oldWindow;
    globalThis.BroadcastChannel = oldChannel;
  }
});
