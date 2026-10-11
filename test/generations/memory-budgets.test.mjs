import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { after, afterEach, mock, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  createGenerationState, appendChunk, addSubscriber, addLocalSubscriber, markComplete, markError,
  cancel, deleteGenerationsForProviderShutdown, generationMemoryUsage, getGenerationState,
} from '../../server/generations/store.js';
import { readCheckpoint } from '../../server/generations/checkpoint.js';
import {
  GENERATION_REPLAY_BYTES, GENERATIONS_TOTAL_BYTES, CHUNK_OVERHEAD_BYTES, SUBSCRIBER_BACKLOG_BYTES,
  SUBSCRIBER_STALL_MS, REPLAY_LIMIT_MESSAGE, CHECKPOINT_LIMIT_MESSAGE,
  GENERATIONS_MAX_COUNT, GENERATION_REQUEST_BYTES,
} from '../../server/generations/memory-limits.js';
const oldHome = process.env.MINNOW_HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-gen-budgets-'));
process.env.MINNOW_HOME = home; resetMinnowHomeCache();
afterEach(() => { deleteGenerationsForProviderShutdown(); mock.timers.reset(); });
after(() => {
  if (oldHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = oldHome;
  resetMinnowHomeCache(); fs.rmSync(home, { recursive: true, force: true });
});
function response(slow = false) {
  return Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, writableLength: 0, writes: [],
    write(buf) { this.writes.push(Buffer.from(buf)); this.writableLength = slow ? buf.length : 0; return !slow; },
    end() { this.writableEnded = true; }, destroy() { this.destroyed = true; this.emit('close'); },
  });
}
test('per-generation boundary preserves prefix and reports explicit error to current and replay subscribers', () => {
  const state = createGenerationState({ providerId: 'p', body: {}, persist: true });
  state.upstreamController = new AbortController();
  const controller = state.upstreamController;
  let terminal;
  addLocalSubscriber(state, { onChunk() {}, onEnd: (value) => { terminal = value; } });
  const prefix = Buffer.alloc(GENERATION_REPLAY_BYTES - CHUNK_OVERHEAD_BYTES, 97);
  appendChunk(state, prefix);
  assert.equal(state.status, 'streaming');
  appendChunk(state, Buffer.from('x'));
  assert.equal(state.status, 'error'); assert.equal(terminal.errorMessage, REPLAY_LIMIT_MESSAGE);
  assert.equal(controller.signal.aborted, true);
  assert.equal(state.totalBytes, prefix.length); assert.equal(state.chunks.length, 1);
  const replay = response(); addSubscriber(state, replay);
  assert.equal(Buffer.concat(replay.writes).subarray(0, prefix.length).compare(prefix), 0);
  assert.ok(Buffer.concat(replay.writes).toString().endsWith(`event: end\ndata: ${JSON.stringify(terminal)}\n\n`));
  markComplete(state); assert.equal(state.status, 'error');
});
test('oversized single chunks are rejected before retaining or checkpointing them', () => {
  const state = createGenerationState({ providerId: 'p', body: {}, persist: true });
  appendChunk(state, Buffer.alloc(GENERATION_REPLAY_BYTES + 1));
  assert.equal(state.chunks.length, 0); assert.equal(state.totalBytes, 0);
  assert.equal(readCheckpoint(state.id).status, 'error'); assert.equal(readCheckpoint(state.id).sse.length, 0);
});
test('concurrent verbose streams enforce aggregate budget and shutdown releases all accounting', () => {
  const count = Math.ceil(GENERATIONS_TOTAL_BYTES / GENERATION_REPLAY_BYTES) + 1;
  const states = Array.from({ length: count }, () => createGenerationState({ providerId: 'p', body: {} }));
  const chunk = Buffer.alloc(1024 * 1024);
  for (let round = 0; round < 40; round++) for (const state of states) {
    appendChunk(state, chunk); assert.ok(generationMemoryUsage().retainedBytes <= GENERATIONS_TOTAL_BYTES);
  }
  assert.ok(states.some((state) => state.status === 'error'));
  deleteGenerationsForProviderShutdown();
  assert.deepEqual(generationMemoryUsage(), { retainedBytes: 0, generationCount: 0, subscriberBytes: 0, subscriberCount: 0 });
});

test('finished tool rounds release request history while retaining complete replay', () => {
  const body = { model: 'fixture', messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }] };
  const active = createGenerationState({ providerId: 'codex-cli', body });
  const activeBytes = generationMemoryUsage().retainedBytes;
  const reply = Buffer.from('data: {"text":"tool round"}\n\n');
  const finished = [];
  for (let round = 0; round < 24; round++) {
    const state = createGenerationState({ providerId: 'claude-code-cli', body, persist: true });
    appendChunk(state, reply);
    markComplete(state);
    finished.push(state);
  }
  assert.ok(generationMemoryUsage().retainedBytes < activeBytes + 64 * 1024);
  assert.ok(active.requestBody.length > 8 * 1024 * 1024, 'active requests remain available for retries');
  for (const state of finished) {
    assert.equal(state.requestBody.length, 0);
    const replay = response(); addSubscriber(getGenerationState(state.id), replay);
    assert.ok(Buffer.concat(replay.writes).toString().startsWith(reply.toString()));
    assert.match(Buffer.concat(replay.writes).toString(), /"status":"complete"/);
    assert.equal(readCheckpoint(state.id).sse.compare(reply), 0);
  }
  deleteGenerationsForProviderShutdown();
  assert.equal(generationMemoryUsage().retainedBytes, 0);
});

test('every terminal outcome releases request bytes once before notifying subscribers', () => {
  for (const finish of [markComplete, (state) => markError(state, 'fixture failure'), cancel]) {
    const state = createGenerationState({ providerId: 'p', body: { text: 'x'.repeat(1024 * 1024) } });
    const requestBytes = state.requestBody.length;
    const before = generationMemoryUsage().retainedBytes;
    let ended = false;
    let requestBytesAtEnd;
    addLocalSubscriber(state, { onChunk() {}, onEnd() {
      ended = true;
      requestBytesAtEnd = state.requestBody.length;
    } });
    finish(state);
    assert.ok(ended);
    assert.equal(requestBytesAtEnd, 0);
    assert.equal(state.requestBody.length, 0);
    assert.equal(generationMemoryUsage().retainedBytes, before - requestBytes);
    finish(state);
    assert.equal(generationMemoryUsage().retainedBytes, before - requestBytes);
  }
});
test('slow subscribers detach at cap while fast subscribers finish; drain never writes ahead', () => {
  const state = createGenerationState({ providerId: 'p', body: {} });
  const slow = response(true); const fast = response();
  addSubscriber(state, slow); addSubscriber(state, fast);
  const chunk = Buffer.alloc(64 * 1024, 97);
  for (let i = 0; i < 80; i++) {
    appendChunk(state, chunk);
    assert.ok(generationMemoryUsage().subscriberBytes <= SUBSCRIBER_BACKLOG_BYTES);
  }
  assert.equal(slow.writes.length, 1); assert.equal(slow.destroyed, true);
  assert.equal(slow.listenerCount('drain'), 0);
  markComplete(state); assert.equal(fast.writableEnded, true);
  assert.equal(Buffer.concat(fast.writes).subarray(0, 80 * chunk.length).length, 80 * chunk.length);
});
test('large terminal replay drains lazily without filling the live backlog budget', () => {
  const state = createGenerationState({ providerId: 'mtplx-local', body: {} });
  const prefix = Buffer.alloc(9 * 1024 * 1024, 97);
  appendChunk(state, prefix);
  markComplete(state);
  const replay = response(true);
  addSubscriber(state, replay);
  assert.equal(replay.destroyed, false);
  assert.equal(replay.writes.length, 1);
  while (!replay.writableEnded) {
    assert.ok(generationMemoryUsage().subscriberBytes < 128 * 1024);
    replay.writableLength = 0;
    replay.emit('drain');
  }
  const received = Buffer.concat(replay.writes);
  assert.equal(received.subarray(0, prefix.length).compare(prefix), 0);
  assert.equal(received.subarray(prefix.length).toString(), '\n\nevent: end\ndata: {"status":"complete"}\n\n');
  assert.equal(generationMemoryUsage().subscriberCount, 0);
  assert.equal(replay.listenerCount('drain'), 0);
});
test('live chunks and terminal event follow the retained replay while it drains', () => {
  const state = createGenerationState({ providerId: 'p', body: {} });
  appendChunk(state, Buffer.from('first'));
  appendChunk(state, Buffer.from('second'));
  const replay = response(true);
  addSubscriber(state, replay);
  appendChunk(state, Buffer.from('third'));
  markComplete(state);
  while (!replay.writableEnded) {
    replay.writableLength = 0;
    replay.emit('drain');
  }
  assert.equal(Buffer.concat(replay.writes).toString(), 'firstsecondthird\n\nevent: end\ndata: {"status":"complete"}\n\n');
});
test('eviction preserves buffers for an actively draining replay, then releases them', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const state = createGenerationState({ providerId: 'p', body: {} });
  appendChunk(state, Buffer.alloc(128 * 1024, 97));
  markComplete(state);
  const replay = response(true);
  addSubscriber(state, replay);
  mock.timers.tick(20_000);
  replay.writableLength = 0;
  replay.emit('drain');
  mock.timers.tick(10_001);
  assert.equal(state.totalBytes, 128 * 1024);
  assert.equal(replay.destroyed, false);
  while (!replay.writableEnded) {
    replay.writableLength = 0;
    replay.emit('drain');
  }
  mock.timers.tick(30_000);
  assert.equal(generationMemoryUsage().retainedBytes, 0);
});
test('stalled terminal subscribers and canceled/evicted generations release listeners and memory', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const state = createGenerationState({ providerId: 'p', body: {} });
  const slow = response(true); addSubscriber(state, slow); appendChunk(state, Buffer.from('prefix'));
  cancel(state); assert.equal(state.status, 'cancelled');
  mock.timers.tick(SUBSCRIBER_STALL_MS + 1);
  assert.equal(slow.destroyed, true); assert.equal(slow.listenerCount('drain'), 0);
  assert.equal(generationMemoryUsage().retainedBytes, 0);
});
test('oversized disk replay is rejected before body read, including aggregate admission', () => {
  const id = randomUUID(); const directory = path.join(home, 'generations'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ status: 'complete' }));
  const fd = fs.openSync(path.join(directory, `${id}.sse`), 'w'); fs.ftruncateSync(fd, GENERATION_REPLAY_BYTES + 1); fs.closeSync(fd);
  const spy = mock.method(fs, 'readSync');
  const saved = readCheckpoint(id); assert.equal(saved.sse.length, 0); assert.equal(saved.status, 'error');
  assert.equal(spy.mock.callCount(), 2, 'only the small metadata file is read; no SSE body read');
  spy.mock.restore();
  assert.equal(saved.meta.errorMessage, CHECKPOINT_LIMIT_MESSAGE);
  const state = getGenerationState(id); assert.equal(state.status, 'error'); assert.equal(state.totalBytes, 0);
  assert.ok(generationMemoryUsage().retainedBytes < 1024);
});
test('aggregate capacity is checked before reading a smaller eligible checkpoint', () => {
  const replayBytes = GENERATION_REPLAY_BYTES - 1024 * 1024;
  for (let i = 0; i < Math.floor(GENERATIONS_TOTAL_BYTES / replayBytes); i++) {
    const state = createGenerationState({ providerId: 'p', body: {} });
    appendChunk(state, Buffer.alloc(replayBytes));
  }
  const id = randomUUID(); const directory = path.join(home, 'generations');
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ status: 'complete' }));
  const fd = fs.openSync(path.join(directory, `${id}.sse`), 'w'); fs.ftruncateSync(fd, replayBytes); fs.closeSync(fd);
  const state = getGenerationState(id);
  assert.equal(state.status, 'error'); assert.equal(state.errorMessage, CHECKPOINT_LIMIT_MESSAGE);
  assert.equal(state.chunks.length, 0); assert.ok(generationMemoryUsage().retainedBytes <= GENERATIONS_TOTAL_BYTES);
});
test('request size and empty-generation count are bounded before store admission', () => {
  assert.throws(() => createGenerationState({ providerId: 'p', body: { text: 'x'.repeat(GENERATION_REQUEST_BYTES) } }), { code: 'GENERATION_MEMORY_LIMIT', statusCode: 413 });
  assert.equal(generationMemoryUsage().generationCount, 0);
  for (let i = 0; i < GENERATIONS_MAX_COUNT; i++) createGenerationState({ providerId: 'p', body: {} });
  assert.throws(() => createGenerationState({ providerId: 'p', body: {} }), { code: 'GENERATION_MEMORY_LIMIT', statusCode: 503 });
  assert.equal(generationMemoryUsage().generationCount, GENERATIONS_MAX_COUNT);
});
test('many tiny chunks account overhead and tiny buffer views cannot retain giant backing storage', () => {
  const state = createGenerationState({ providerId: 'p', body: {} });
  const backing = Buffer.alloc(1024 * 1024); appendChunk(state, backing.subarray(0, 1));
  assert.equal(state.chunks[0].buffer.byteLength, 1);
  const before = generationMemoryUsage().retainedBytes;
  for (let i = 0; i < 10000; i++) appendChunk(state, Buffer.from('x'));
  assert.equal(generationMemoryUsage().retainedBytes - before, 10000 * (1 + CHUNK_OVERHEAD_BYTES));
});
