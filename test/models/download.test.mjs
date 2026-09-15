/**
 * Model download job tests — resume Range, checksum, split GGUF, queue, interrupt.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  listDownloads,
  MAX_CONCURRENT_DOWNLOADS,
  resetDownloadsForTests,
  startDownload,
  pauseDownload,
  resumeDownload,
} from '../../server/models/download.js';
import { downloadHfFile, parseLinkedEtag } from '../../server/models/hf-client.js';
import { getDownloadsIndexPath } from '../../server/models/paths.js';
import { scanInstalledArtifacts } from '../../server/models/installed.js';

const ORIGINAL_FETCH = globalThis.fetch;

/** 20-byte fixture used by Range resume + matching etag tests. */
const FULL20 = Buffer.from('ABCDEFGHIJ0123456789');
const FULL20_SHA256 = '459e7c9bf7428f9977951fdb9c32e5d320d1ebba435e77c93b70ba279513b0c4';
const FULL20_PREFIX = FULL20.subarray(0, 8);
const FULL20_REST = FULL20.subarray(8);

/** True 16-byte file for the corrupt-partial hash failure. */
const TRUE16 = Buffer.from('0123456789abcdef');
const TRUE16_SHA256 = '9f9f5111f7b27a781f1f1ddde5ebc2dd2b796bfc7365c9c28b548e564176929f';
const TRUE16_REST = TRUE16.subarray(8);
const CORRUPT_PREFIX = Buffer.from('CORRUPT!');

const HELLO_GGUF = Buffer.from('hello-gguf');
const HELLO_GGUF_SHA256 = '3092e6a166425d4c209342339256d561ab6fa908e5a8ef2df28688e50dcd24c3';

/**
 * @param {RequestInit | undefined} init
 * @param {string} name
 */
function getHeader(init, name) {
  const headers = init?.headers;
  if (!headers) return null;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name);
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

/**
 * @param {string} id
 * @param {(row: object) => boolean} predicate
 * @param {number} [attempts]
 */
async function waitForJob(id, predicate, attempts = 80) {
  let row = null;
  for (let i = 0; i < attempts; i += 1) {
    const jobs = await listDownloads();
    row = jobs.find((item) => item.id === id) ?? null;
    if (row && predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return row;
}

describe('model downloads', () => {
  /** @type {string} */
  let homeDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-model-dl-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await resetDownloadsForTests();
  });

  after(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    await resetDownloadsForTests();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Abort in-flight jobs so a failed hanging-download test cannot stall the suite.
  afterEach(async () => {
    await resetDownloadsForTests();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test('parseLinkedEtag strips quotes, W/, and sha256: prefix', () => {
    assert.equal(parseLinkedEtag(`"${FULL20_SHA256}"`), FULL20_SHA256);
    assert.equal(parseLinkedEtag(`W/"sha256:${FULL20_SHA256}"`), FULL20_SHA256);
    assert.equal(parseLinkedEtag(null), null);
    assert.equal(parseLinkedEtag('"not-a-digest"'), null);
  });

  test('pause keeps bytes, duplicate requests reuse the job, and resume completes it', async () => {
    const ranges = [];
    globalThis.fetch = async (_input, init) => {
      if (init?.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': '20' } });
      const range = getHeader(init, 'Range');
      ranges.push(range);
      if (range) return new Response(FULL20_REST, { status: 206, headers: { 'Content-Range': 'bytes 8-19/20', 'Content-Length': '12' } });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(FULL20_PREFIX); } }), { headers: { 'Content-Length': '20' } });
    };
    const body = { repoId: 'org/pausable', filename: 'nested/model-Q4_K_M.gguf' };
    const [job, duplicate] = await Promise.all([startDownload(body), startDownload(body)]);
    assert.equal(duplicate.id, job.id);
    for (let i = 0; i < 100; i++) {
      const size = await fs.stat(`${job.destPath}.partial`).then((s) => s.size).catch(() => 0);
      if (size === 8) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const paused = await pauseDownload(job.id);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.bytesReceived, 8);
    assert.equal((await fs.stat(`${job.destPath}.partial`)).size, 8);
    assert.equal((await listDownloads()).find((row) => row.id === job.id).status, 'paused');
    await resumeDownload(job.id);
    const done = await waitForJob(job.id, (row) => row.status === 'completed');
    assert.equal(done.status, 'completed');
    assert.ok(ranges.includes('bytes=8-'));
    assert.deepEqual(await fs.readFile(job.destPath), FULL20);
    assert.match(job.destPath, /nested/);
    const installed = await scanInstalledArtifacts({ includeCustomDirs: false });
    assert.ok(installed.some((artifact) => artifact.path === job.destPath), 'nested download appears in My Models');
  });

  test('incorrect Range response cannot append corrupt bytes', async () => {
    const destPath = path.join(homeDir, 'wrong-range.gguf');
    await fs.writeFile(`${destPath}.partial`, FULL20_PREFIX);
    globalThis.fetch = async () => new Response(FULL20_REST, { status: 206, headers: { 'Content-Range': 'bytes 0-11/20' } });
    await assert.rejects(() => downloadHfFile({ repoId: 'org/demo', filename: 'model.gguf', destPath }), /incorrect resume offset/);
    assert.deepEqual(await fs.readFile(`${destPath}.partial`), FULL20_PREFIX);
  });

  test('a full partial receiving HTTP 416 restarts without looping on an invalid range', async () => {
    const destPath = path.join(homeDir, 'range-416.gguf');
    await fs.writeFile(`${destPath}.partial`, FULL20);
    const ranges = [];
    globalThis.fetch = async (_url, init) => {
      const range = getHeader(init, 'Range'); ranges.push(range);
      return range ? new Response(null, { status: 416 }) : new Response(FULL20, { headers: { 'Content-Length': '20' } });
    };
    await downloadHfFile({ repoId: 'org/demo', filename: 'model.gguf', destPath });
    assert.deepEqual(ranges, ['bytes=20-', null]);
    assert.deepEqual(await fs.readFile(destPath), FULL20);
  });

  test('redirect etag is verified even when the CDN omits it', async () => {
    const destPath = path.join(homeDir, 'redirect-etag.gguf');
    globalThis.fetch = async (url) => String(url).includes('huggingface.co/')
      ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/weights', 'X-Linked-Etag': `"${FULL20_SHA256}"` } })
      : new Response(Buffer.from('wrong bytes'));
    await assert.rejects(() => downloadHfFile({ repoId: 'org/demo', filename: 'model.gguf', destPath }), /Checksum mismatch/);
    await assert.rejects(() => fs.stat(destPath));
  });

  test('reconciles queued/running jobs after server restart', async () => {
    const destPath = path.join(homeDir, 'models', 'artifacts', 'org--demo', 'model-Q4_K_M.gguf');
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(`${destPath}.partial`, FULL20_PREFIX);

    const staleJob = {
      id: '11111111-1111-4111-8111-111111111111',
      repoId: 'org/demo',
      filename: 'model-Q4_K_M.gguf',
      repoFilePath: 'model-Q4_K_M.gguf',
      quant: 'Q4_K_M',
      status: 'running',
      bytesReceived: 8,
      totalBytes: 20,
      destPath,
      createdAt: 1_700_000_000_000,
    };

    /** @type {string[]} */
    const ranges = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/resolve/main/')) {
        ranges.push(String(getHeader(init, 'Range') || ''));
        return new Response(FULL20_REST, {
          status: 206,
          headers: {
            'Content-Length': String(FULL20_REST.length),
            'Content-Range': `bytes 8-19/${FULL20.length}`,
            'X-Linked-Etag': `"${FULL20_SHA256}"`,
          },
        });
      }
      return ORIGINAL_FETCH(input);
    };

    // Reset first (wipes the index), then persist the stale job so loadJobs sees it.
    await resetDownloadsForTests();
    await fs.mkdir(path.dirname(getDownloadsIndexPath()), { recursive: true });
    await fs.writeFile(
      getDownloadsIndexPath(),
      `${JSON.stringify({ version: 1, jobs: [staleJob] }, null, 2)}\n`,
      'utf8',
    );
    const jobs = await listDownloads();
    assert.equal(jobs.length, 1);
    assert.notEqual(jobs[0].status, 'failed');
    assert.equal(jobs[0].interrupted, true);
    assert.equal(jobs[0].resumeAt, 8);
    // Artifacts stay on disk so Range can resume; the pump requeues immediately.
    await fs.stat(`${destPath}.partial`).catch(async () => {
      // Already renamed if the mock completed before this assertion.
      await fs.stat(destPath);
    });

    const final = await waitForJob(staleJob.id, (row) => row.status === 'completed' || row.status === 'failed');
    assert.equal(final?.status, 'completed');
    assert.ok(ranges.includes('bytes=8-'));
    const written = await fs.readFile(destPath);
    assert.deepEqual(written, FULL20);
  });

  test('a deliberately paused persisted job stays paused after restart', async () => {
    await resetDownloadsForTests();
    const paused = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repoId: 'org/paused', filename: 'model.gguf', repoFilePath: 'model.gguf', status: 'paused', bytesReceived: 8, totalBytes: 20, destPath: path.join(homeDir, 'paused.gguf'), createdAt: Date.now() };
    await fs.writeFile(getDownloadsIndexPath(), JSON.stringify({ version: 1, jobs: [paused] }));
    globalThis.fetch = async () => { throw new Error('Paused jobs must not fetch'); };
    const jobs = await listDownloads();
    assert.equal(jobs[0].status, 'paused');
    assert.equal(jobs[0].bytesReceived, 8);
  });

  test('downloadHfFile rejects truncated streams but keeps the partial', async () => {
    globalThis.fetch = async () =>
      new Response(ReadableStream.from([Buffer.from('abc')]), {
        status: 200,
        headers: { 'Content-Length': '9' },
      });

    const destPath = path.join(homeDir, 'truncated.gguf');
    await assert.rejects(
      () =>
        downloadHfFile({
          repoId: 'org/demo',
          filename: 'model-Q4_K_M.gguf',
          destPath,
        }),
      /Incomplete download/,
    );
    await assert.rejects(() => fs.stat(destPath));
    const partial = await fs.stat(`${destPath}.partial`);
    assert.equal(partial.size, 3);
  });

  test('downloadHfFile resumes with Range 206 and matching X-Linked-Etag', async () => {
    const destPath = path.join(homeDir, 'resume-206.gguf');
    await fs.writeFile(`${destPath}.partial`, FULL20_PREFIX);

    /** @type {string[]} */
    const ranges = [];
    globalThis.fetch = async (input, init) => {
      ranges.push(String(getHeader(init, 'Range') || ''));
      return new Response(FULL20_REST, {
        status: 206,
        headers: {
          'Content-Length': String(FULL20_REST.length),
          'Content-Range': `bytes 8-19/${FULL20.length}`,
          'X-Linked-Etag': `"sha256:${FULL20_SHA256}"`,
        },
      });
    };

    const result = await downloadHfFile({
      repoId: 'org/demo',
      filename: 'model-Q4_K_M.gguf',
      destPath,
    });
    assert.equal(result.bytesReceived, 20);
    assert.equal(result.totalBytes, 20);
    assert.ok(ranges.includes('bytes=8-'));
    assert.deepEqual(await fs.readFile(destPath), FULL20);
    await assert.rejects(() => fs.stat(`${destPath}.partial`));
  });

  test('downloadHfFile treats 200 as a restart (truncates the partial)', async () => {
    const destPath = path.join(homeDir, 'resume-200.gguf');
    await fs.writeFile(`${destPath}.partial`, FULL20_PREFIX);

    globalThis.fetch = async (input, init) => {
      assert.equal(getHeader(init, 'Range'), 'bytes=8-');
      return new Response(FULL20, {
        status: 200,
        headers: {
          'Content-Length': String(FULL20.length),
          'X-Linked-Etag': `"${FULL20_SHA256}"`,
        },
      });
    };

    await downloadHfFile({
      repoId: 'org/demo',
      filename: 'model-Q4_K_M.gguf',
      destPath,
    });
    // Truncate + rewrite, not PREFIX+FULL appended.
    assert.deepEqual(await fs.readFile(destPath), FULL20);
    assert.equal((await fs.stat(destPath)).size, 20);
  });

  test('matching X-Linked-Etag succeeds', async () => {
    const destPath = path.join(homeDir, 'etag-ok.gguf');
    globalThis.fetch = async () =>
      new Response(HELLO_GGUF, {
        status: 200,
        headers: {
          'Content-Length': String(HELLO_GGUF.length),
          'X-Linked-Etag': `W/"${HELLO_GGUF_SHA256}"`,
        },
      });

    await downloadHfFile({
      repoId: 'org/demo',
      filename: 'hello.gguf',
      destPath,
    });
    assert.deepEqual(await fs.readFile(destPath), HELLO_GGUF);
  });

  test('corrupt partial fails the sha256 check against the true-file etag', async () => {
    const destPath = path.join(homeDir, 'etag-bad.gguf');
    await fs.writeFile(`${destPath}.partial`, CORRUPT_PREFIX);

    globalThis.fetch = async (input, init) => {
      assert.equal(getHeader(init, 'Range'), 'bytes=8-');
      return new Response(TRUE16_REST, {
        status: 206,
        headers: {
          'Content-Length': String(TRUE16_REST.length),
          'Content-Range': 'bytes 8-15/16',
          'X-Linked-Etag': `"${TRUE16_SHA256}"`,
        },
      });
    };

    await assert.rejects(
      () =>
        downloadHfFile({
          repoId: 'org/demo',
          filename: 'true.gguf',
          destPath,
        }),
      /Checksum mismatch/,
    );
    await assert.rejects(() => fs.stat(destPath));
    await assert.rejects(() => fs.stat(`${destPath}.partial`));
  });

  test('startDownload completes a mocked HF file', async () => {
    await resetDownloadsForTests();

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/models/') && url.includes('/tree/main')) {
        return new Response(
          JSON.stringify([{ path: 'model-Q4_K_M.gguf', size: 10, type: 'file' }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/resolve/main/')) {
        return new Response(HELLO_GGUF, {
          status: 200,
          headers: { 'Content-Length': String(HELLO_GGUF.length) },
        });
      }
      return ORIGINAL_FETCH(input);
    };

    const job = await startDownload({ repoId: 'org/complete', filename: 'hello.gguf' });

    const final = await waitForJob(job.id, (row) => row.status === 'completed' || row.status === 'failed');
    assert.equal(final?.status, 'completed');
    assert.equal(final?.bytesReceived, 10);
    const stat = await fs.stat(final.destPath);
    assert.equal(stat.size, 10);
  });

  test('split GGUF repo downloads every shard and destPath is shard 1', async () => {
    await resetDownloadsForTests();

    const shard1 = Buffer.from('shard-one!!');
    const shard2 = Buffer.from('shard-two!!');
    const shard3 = Buffer.from('shard-3!!!!');
    const files = {
      'model-Q4_K_M-00001-of-00003.gguf': shard1,
      'model-Q4_K_M-00002-of-00003.gguf': shard2,
      'model-Q4_K_M-00003-of-00003.gguf': shard3,
    };

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/models/') && url.includes('/tree/main')) {
        return new Response(
          JSON.stringify([
            { path: 'model-Q8_0.gguf', size: 4, type: 'file' },
            ...Object.entries(files).map(([p, body]) => ({
              path: p,
              size: body.length,
              type: 'file',
            })),
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/resolve/main/')) {
        const name = decodeURIComponent(url.split('/resolve/main/')[1] || '');
        const body = files[name];
        if (!body) return new Response('missing', { status: 404 });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Length': String(body.length) },
        });
      }
      return ORIGINAL_FETCH(input);
    };

    const job = await startDownload({ repoId: 'org/split', quant: 'Q4_K_M' });
    const final = await waitForJob(job.id, (row) => row.status === 'completed' || row.status === 'failed');
    assert.equal(final?.status, 'completed');
    assert.equal(path.basename(final.destPath), 'model-Q4_K_M-00001-of-00003.gguf');
    const dir = path.dirname(final.destPath);
    assert.deepEqual(await fs.readFile(path.join(dir, 'model-Q4_K_M-00001-of-00003.gguf')), shard1);
    assert.deepEqual(await fs.readFile(path.join(dir, 'model-Q4_K_M-00002-of-00003.gguf')), shard2);
    assert.deepEqual(await fs.readFile(path.join(dir, 'model-Q4_K_M-00003-of-00003.gguf')), shard3);
  });

  test('split GGUF listing with missing shards is refused', async () => {
    await resetDownloadsForTests();
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/tree/main')) {
        return new Response(
          JSON.stringify([
            { path: 'model-00001-of-00003.gguf', size: 1, type: 'file' },
            { path: 'model-00002-of-00003.gguf', size: 1, type: 'file' },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return ORIGINAL_FETCH(input);
    };

    await assert.rejects(
      () => startDownload({ repoId: 'org/broken-split', filename: 'model-00001-of-00003.gguf' }),
      /expects 3 shards/,
    );
  });

  test('queue runs at most two jobs across repos and one per repo', async () => {
    await resetDownloadsForTests();
    assert.equal(MAX_CONCURRENT_DOWNLOADS, 2);

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = String(init?.method || 'GET').toUpperCase();
      if (url.includes('/resolve/main/') && method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'Content-Length': '100' } });
      }
      if (url.includes('/resolve/main/')) {
        // pull() never settles, so the job stays `running` until abort.
        return new Response(
          new ReadableStream({
            pull() {
              return new Promise((resolve, reject) => {
                const signal = init?.signal;
                if (signal?.aborted) {
                  reject(new Error('Download cancelled'));
                  return;
                }
                signal?.addEventListener(
                  'abort',
                  () => reject(new Error('Download cancelled')),
                  { once: true },
                );
              });
            },
          }),
          { status: 200, headers: { 'Content-Length': '100' } },
        );
      }
      return ORIGINAL_FETCH(input);
    };

    const a = await startDownload({ repoId: 'org/alpha', filename: 'a.gguf' });
    const b = await startDownload({ repoId: 'org/beta', filename: 'b.gguf' });
    const c = await startDownload({ repoId: 'org/gamma', filename: 'c.gguf' });
    const afterThree = await listDownloads();
    const running = afterThree.filter((row) => row.status === 'running');
    const queued = afterThree.filter((row) => row.status === 'queued');
    assert.equal(running.length, 2);
    assert.equal(queued.length, 1);
    assert.ok([a.id, b.id, c.id].includes(queued[0].id));

    await resetDownloadsForTests();
    const first = await startDownload({ repoId: 'org/same', filename: 'one.gguf' });
    const second = await startDownload({ repoId: 'org/same', filename: 'two.gguf' });
    const sameRepo = await listDownloads();
    const sameRunning = sameRepo.filter((row) => row.status === 'running');
    const sameQueued = sameRepo.filter((row) => row.status === 'queued');
    assert.equal(sameRunning.length, 1);
    assert.equal(sameQueued.length, 1);
    assert.equal(sameRunning[0].id, first.id);
    assert.equal(sameQueued[0].id, second.id);

    await resetDownloadsForTests();
  });
});
