import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatPublicationBatch, serializeChatPublicationBatches } from '../../src/chat/shared-chat-batch';

test('concurrent chat publications share a request and await its acknowledgement', async () => {
  const batches: string[][] = [];
  let acknowledge!: () => void;
  const send = createChatPublicationBatch(async frames => {
    batches.push(frames.map(frame => frame.chatId));
    await new Promise<void>(resolve => { acknowledge = resolve; });
  });
  let completed = 0;
  const pending = ['one', 'two', 'three'].map(chatId => send({ chatId, epoch: 'turn', running: true })
    .then(() => { completed += 1; }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(batches, [['one', 'two', 'three']]);
  assert.equal(completed, 0);
  acknowledge();
  await Promise.all(pending);
  assert.equal(completed, 3);
});

test('a failed publication batch rejects every waiter so each publisher can recover its snapshot', async () => {
  const send = createChatPublicationBatch(() => { throw new Error('offline'); });
  const result = await Promise.allSettled(['one', 'two'].map(chatId => send({ chatId, epoch: 'turn', running: false })));
  assert.ok(result.every(row => row.status === 'rejected' && /offline/.test(String(row.reason))));
});

test('one stale chat cannot prevent another chat from acknowledging its terminal frame', async () => {
  const send = createChatPublicationBatch(async () => [{ ok: false, error: 'stale lease' }, { ok: true }]);
  const result = await Promise.allSettled(['stale', 'finished'].map(chatId => send({ chatId, epoch: 'turn', running: false })));
  assert.equal(result[0].status, 'rejected');
  assert.equal(result[1].status, 'fulfilled');
});

test('publication bodies retain frame order and split bounded batches', () => {
  const frames = Array.from({ length: 70 }, (_, index) => ({ chatId: String(index), epoch: 'turn', running: true }));
  const bodies = serializeChatPublicationBatches('pc', frames).map(({ body }) => JSON.parse(body));
  assert.deepEqual(bodies.map(body => body.frames.length), [64, 6]);
  assert.deepEqual(bodies.flatMap(body => body.frames), frames);
  assert.ok(bodies.every(body => body.hostId === 'pc'));
  const large = { ...frames[0], fields: { name: '漢'.repeat(1_100_000) } };
  const split = serializeChatPublicationBatches('pc', [large, large]);
  assert.equal(split.length, 2);
  assert.ok(split.every(({ body }) => Buffer.byteLength(body) < 16 * 1024 * 1024));
});
