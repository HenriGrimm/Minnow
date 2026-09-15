import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupGgufFiles } from '../../server/models/hf-files.js';
import { listRepoFilesRecursive, nextHfPage } from '../../server/models/hf-client.js';

test('picker groups shards, sums size, preserves paths, and omits projectors', () => {
  const result = groupGgufFiles([
    { path: 'Q4/model-Q4_K_M-00002-of-00002.gguf', size: 20 },
    { path: 'Q4/model-Q4_K_M-00001-of-00002.gguf', size: 10 },
    { path: 'mmproj-F16.gguf', size: 3 },
    { path: 'model-Q8_0.gguf', size: 40 },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].quant, 'Q4_K_M');
  assert.equal(result[0].sizeBytes, 30);
  assert.equal(result[0].filename, 'Q4/model-Q4_K_M-00001-of-00002.gguf');
  assert.equal(result[0].files.length, 2);
});

test('incomplete shards are disabled and missing sizes stay unknown', () => {
  const files = groupGgufFiles([
    { path: 'model-Q4_K_M-00001-of-00002.gguf', size: 10 },
    { path: 'model-Q8_0.gguf' },
  ]);
  assert.match(files[0].error, /expects 2 shards/);
  assert.equal(files[1].sizeBytes, null);
});

test('pagination only allows the exact Hugging Face endpoint', () => {
  assert.equal(
    nextHfPage('<https://huggingface.co/api/models?cursor=next>; rel="next"', '/api/models'),
    'https://huggingface.co/api/models?cursor=next',
  );
  assert.throws(
    () => nextHfPage('<https://evil.example/api/models>; rel="next"', '/api/models'),
    /Invalid/,
  );
  assert.throws(
    () => nextHfPage('<https://huggingface.co/other>; rel="next"', '/api/models'),
    /Invalid/,
  );
});

test('repository file listing follows the next page before grouping shards', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const second = String(url).includes('cursor=two');
    return new Response(
      JSON.stringify([{ path: `model-Q4_K_M-0000${second ? 2 : 1}-of-00002.gguf`, size: 10 }]),
      {
        headers: second
          ? {}
          : {
              link: '<https://huggingface.co/api/models/org/demo/tree/main?cursor=two>; rel="next"',
            },
      },
    );
  };
  try {
    const result = groupGgufFiles(await listRepoFilesRecursive('org/demo'));
    assert.equal(calls.length, 2);
    assert.equal(result[0].error, null);
    assert.equal(result[0].sizeBytes, 20);
  } finally {
    globalThis.fetch = original;
  }
});
