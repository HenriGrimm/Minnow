import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { readJsonBody } from '../../server/runtime/json-body.js';

test('JSON upload accepts UTF-8 at the exact byte boundary and releases listeners', async () => {
  const req = new PassThrough();
  const json = Buffer.from('{"text":"é"}');
  const result = readJsonBody(req, json.length);
  req.end(json);
  assert.deepEqual(await result, { text: 'é' });
  for (const event of ['data', 'end', 'error', 'close', 'aborted']) assert.equal(req.listenerCount(event), 0);
});

test('JSON upload rejects declared and streamed oversized bodies without keeping listeners', async () => {
  for (const declared of [true, false]) {
    const req = new PassThrough();
    req.headers = declared ? { 'content-length': '1000' } : {};
    const result = readJsonBody(req, 4);
    if (!declared) req.write('12345');
    await assert.rejects(result, error => error.statusCode === 413);
    assert.equal(req.listenerCount('data'), 0);
    req.end();
  }
});

test('aborted or prematurely closed JSON uploads settle and detach', async () => {
  for (const event of ['aborted', 'close']) {
    const req = new PassThrough();
    const result = readJsonBody(req);
    req.write('{"partial":');
    req.emit(event);
    await assert.rejects(result, /Request aborted/);
    assert.equal(req.listenerCount('data'), 0);
    assert.equal(req.listenerCount('end'), 0);
    req.end();
  }
});

test('invalid JSON reports a 400 error', async () => {
  const req = new PassThrough();
  const result = readJsonBody(req);
  req.end('{');
  await assert.rejects(result, error => error.statusCode === 400);
});
