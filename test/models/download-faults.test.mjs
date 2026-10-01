import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { getDownloadsIndexPath } from '../../server/models/paths.js';
import { startDownload, cancelDownload, pauseDownload, resumeDownload,
  listDownloads, subscribeDownload, resetDownloadsForTests } from '../../server/models/download.js';

const full = Buffer.from('ABCDEFGHIJ0123456789');
const prefix = full.subarray(0, 8);
const previousFetch = globalThis.fetch;
const previousWriteStream = fs.createWriteStream;
const previousHome = process.env.MINNOW_HOME;
let home;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function injectDiskFullAfterFirstWrite(match, committed) {
  let injected = false;
  fs.createWriteStream = (destination, options) => {
    const stream = previousWriteStream(destination, options);
    if (!String(destination).includes(match)) return stream;
    const originalWrite = stream.write.bind(stream);
    let writes = 0;
    stream.write = chunk => {
      writes += 1;
      if (writes === 2 && !injected) {
        injected = true;
        stream.destroy(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
        return false;
      }
      return originalWrite(chunk, error => {
        if (error) stream.destroy(error);
        else committed.resolve();
      });
    };
    return stream;
  };
}

function terminal(jobId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Download did not settle')); }, 5000);
    let unsubscribe = () => {};
    let settled = false;
    const listener = event => {
      if (!['completed', 'failed', 'cancelled', 'paused'].includes(event.status)) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    };
    unsubscribe = subscribeDownload(jobId, listener);
    if (settled) unsubscribe();
  });
}

before(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-download-faults-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  await resetDownloadsForTests();
});
after(async () => {
  fs.createWriteStream = previousWriteStream;
  await resetDownloadsForTests();
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  await fsp.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('ENOSPC after committed bytes fails cleanly, frees admission, and retries valid Range bytes', async () => {
  const committed = deferred();
  injectDiskFullAfterFirstWrite('disk-fault', committed);
  const ranges = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': '20' } });
    if (!String(input).includes('disk-fault')) return new Response(full, { headers: { 'Content-Length': '20' } });
    const range = new Headers(init?.headers).get('Range');
    ranges.push(range);
    if (range) return new Response(full.subarray(8), { status: 206,
      headers: { 'Content-Range': 'bytes 8-19/20', 'Content-Length': '12' } });
    let first = true;
    return new Response(new ReadableStream({ async pull(controller) {
      if (first) { first = false; controller.enqueue(prefix); return; }
      await committed.promise;
      controller.enqueue(full.subarray(8));
      controller.close();
    } }), { headers: { 'Content-Length': '20' } });
  };
  try {
    const job = await startDownload({ repoId: 'org/disk-fault', filename: 'fault.gguf' });
    const failed = await terminal(job.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /ENOSPC/);
    assert.deepEqual(await fsp.readFile(`${job.destPath}.partial`), prefix);
    assert.equal((await listDownloads()).find(row => row.id === job.id).resumeAt, 8);
    const next = await startDownload({ repoId: 'org/after-fault', filename: 'next.gguf' });
    assert.equal((await terminal(next.id)).status, 'completed');
    fs.createWriteStream = previousWriteStream;
    await resumeDownload(job.id);
    assert.equal((await terminal(job.id)).status, 'completed');
    assert.deepEqual(await fsp.readFile(job.destPath), full);
    assert.deepEqual(ranges, [null, 'bytes=8-']);
  } finally { fs.createWriteStream = previousWriteStream; }
});

test('disk-full retry of split GGUF preserves completed shards and resumes only partial bytes', async () => {
  const committed = deferred();
  const names = ['model-Q4_K_M-00001-of-00002.gguf', 'model-Q4_K_M-00002-of-00002.gguf'];
  const requests = [];
  injectDiskFullAfterFirstWrite(names[1], committed);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/tree/main')) return Response.json(names.map(name => ({ path: name, size: 20, type: 'file' })));
    const name = decodeURIComponent(url.split('/resolve/main/')[1]);
    const range = new Headers(init?.headers).get('Range');
    requests.push({ name, range });
    if (name === names[0]) return new Response(full, { headers: { 'Content-Length': '20' } });
    if (range) return new Response(full.subarray(8), { status: 206,
      headers: { 'Content-Range': 'bytes 8-19/20', 'Content-Length': '12' } });
    let first = true;
    return new Response(new ReadableStream({ async pull(controller) {
      if (first) { first = false; controller.enqueue(prefix); return; }
      await committed.promise;
      controller.enqueue(full.subarray(8));
      controller.close();
    } }), { headers: { 'Content-Length': '20' } });
  };
  try {
    const job = await startDownload({ repoId: 'org/split-fault', filename: names[0] });
    assert.equal((await terminal(job.id)).status, 'failed');
    const secondPath = path.join(path.dirname(job.destPath), names[1]);
    assert.deepEqual(await fsp.readFile(job.destPath), full);
    assert.deepEqual(await fsp.readFile(`${secondPath}.partial`), prefix);
    assert.equal((await listDownloads()).find(row => row.id === job.id).resumeAt, 28);
    fs.createWriteStream = previousWriteStream;
    await resumeDownload(job.id);
    assert.equal((await terminal(job.id)).status, 'completed');
    assert.deepEqual(await fsp.readFile(job.destPath), full);
    assert.deepEqual(await fsp.readFile(secondPath), full);
    assert.deepEqual(requests.filter(request => request.name === names[1]).map(request => request.range), [null, 'bytes=8-']);
    await assert.rejects(fsp.stat(`${secondPath}.partial`), { code: 'ENOENT' });
  } finally { fs.createWriteStream = previousWriteStream; }
});

test('cancel wins over pending pause/resume and waits for transfer close before deleting artifacts', async () => {
  const committed = deferred();
  const cancelEntered = deferred();
  const closeAllowed = deferred();
  fs.createWriteStream = (destination, options) => {
    const stream = previousWriteStream(destination, options);
    const originalWrite = stream.write.bind(stream);
    stream.write = chunk => originalWrite(chunk, error => {
      if (error) stream.destroy(error);
      else committed.resolve();
    });
    return stream;
  };
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': '20' } });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(prefix); },
      async cancel() { cancelEntered.resolve(); await closeAllowed.promise; },
    }), { headers: { 'Content-Length': '20' } });
  };
  try {
    const job = await startDownload({ repoId: 'org/cancel-race', filename: 'race.gguf' });
    await committed.promise;
    const pause = pauseDownload(job.id);
    await cancelEntered.promise;
    let cancelled = false;
    const cancel = cancelDownload(job.id).then(result => { cancelled = true; return result; });
    await resumeDownload(job.id);
    assert.equal(cancelled, false);
    assert.deepEqual(await fsp.readFile(`${job.destPath}.partial`), prefix);
    closeAllowed.resolve();
    const results = await Promise.all([pause, cancel]);
    assert.ok(results.every(result => result.status === 'cancelled'));
    await assert.rejects(fsp.stat(job.destPath), { code: 'ENOENT' });
    await assert.rejects(fsp.stat(`${job.destPath}.partial`), { code: 'ENOENT' });
    const saved = await fsp.readFile(getDownloadsIndexPath(), 'utf8');
    await resetDownloadsForTests();
    await fsp.writeFile(getDownloadsIndexPath(), saved);
    assert.equal((await listDownloads()).find(row => row.id === job.id).status, 'cancelled');
  } finally {
    closeAllowed.resolve();
    fs.createWriteStream = previousWriteStream;
  }
});
