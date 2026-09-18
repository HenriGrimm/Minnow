/**
 * llama.cpp engines — fork catalog, custom-fork validation, engine resolution.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  getForkBinDir,
  getForksRoot,
  listApprovedForks,
  normalizeCustomFork,
  parseCmakeFlags,
  parseGithubRepo,
  readEngineConfig,
  validateCustomFork,
} from '../../server/models/llama-forks-catalog.js';
import {
  getInstalledLlamaVariant,
  getManagedLlamaRoot,
  parseLlamaCacheTypes,
  resolveLlamaServer,
} from '../../server/models/llama-runtime.js';
import { writeLlamaCppConfig, pairKvCacheTypes } from '../../server/models/llama-args.js';
import {
  addCustomLlamaFork,
  removeCustomLlamaFork,
  setActiveLlamaEngine,
} from '../../server/models/llama-engines.js';

const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

describe('fork catalog', () => {
  test('ships turbo3 pinned to a commit with its KV types', () => {
    const turbo3 = listApprovedForks().find((f) => f.id === 'turbo3');
    assert.ok(turbo3);
    assert.equal(turbo3.repo, 'Madreag/turbo3-cuda');
    assert.match(turbo3.pinnedSha ?? '', /^[0-9a-f]{40}$/);
    assert.equal(turbo3.backend, 'cuda');
    assert.ok(turbo3.kvCacheTypes && 'turbo3' in turbo3.kvCacheTypes);
    assert.equal(turbo3.asymmetricKv, true);
  });

  test('fork installs never live under the upstream managed root', () => {
    // findBinaryInDir scans one level below the upstream root; a fork there would shadow it.
    const upstream = path.resolve(getManagedLlamaRoot());
    assert.ok(!path.resolve(getForksRoot()).startsWith(`${upstream}${path.sep}`));
  });

  test('missing engine block means upstream', () => {
    assert.deepEqual(readEngineConfig({}), { active: 'upstream', customForks: [] });
  });

  test('drops malformed stored custom forks instead of failing', () => {
    const cfg = readEngineConfig({
      engine: { active: 'x', customForks: [{ label: '' }, { label: 'Ok', repo: 'a/b' }] },
    });
    assert.equal(cfg.customForks.length, 1);
    assert.equal(cfg.customForks[0].repo, 'a/b');
  });
});

describe('custom fork validation', () => {
  test('accepts owner/repo and GitHub URLs', () => {
    assert.equal(parseGithubRepo('ggml-org/llama.cpp'), 'ggml-org/llama.cpp');
    assert.equal(parseGithubRepo('https://github.com/ggml-org/llama.cpp.git'), 'ggml-org/llama.cpp');
    assert.equal(parseGithubRepo('github.com/Madreag/turbo3-cuda/'), 'Madreag/turbo3-cuda');
  });

  test('rejects paths that are not a repo', () => {
    assert.throws(() => parseGithubRepo('https://github.com/a/b/tree/main'));
    assert.throws(() => parseGithubRepo('../../etc'));
    assert.throws(() => parseGithubRepo(''));
  });

  test('cmake flags must be -DNAME=VALUE with no shell metacharacters', () => {
    assert.deepEqual(parseCmakeFlags('-DGGML_CUDA=ON  -DCMAKE_CUDA_ARCHITECTURES=86;89'), [
      '-DGGML_CUDA=ON',
      '-DCMAKE_CUDA_ARCHITECTURES=86;89',
    ]);
    assert.throws(() => parseCmakeFlags('-DFOO=$(whoami)'));
    assert.throws(() => parseCmakeFlags('-DFOO=a&&calc'));
    assert.throws(() => parseCmakeFlags('--build'));
    assert.throws(() => parseCmakeFlags('-P evil.cmake'));
  });

  test('custom ids are prefixed so they cannot collide with approved forks', () => {
    const fork = normalizeCustomFork({ label: 'turbo3', repo: 'a/b', backend: 'cuda' });
    assert.equal(fork.id, 'custom-turbo3');
    assert.equal(fork.origin, 'custom');
  });

  test('a local fork needs an absolute path to an existing file', async () => {
    assert.throws(
      () => validateCustomFork({ label: 'L', source: 'local', binaryPath: 'llama-server' }, []),
      /absolute path/,
    );
    assert.throws(
      () =>
        validateCustomFork(
          { label: 'L', source: 'local', binaryPath: path.join(os.tmpdir(), 'nope', exe) },
          [],
        ),
      /No file/,
    );
  });

  test('duplicate names get a numbered id', () => {
    const first = validateCustomFork({ label: 'Mine', repo: 'a/b' }, []);
    const second = validateCustomFork({ label: 'Mine', repo: 'a/c' }, [first]);
    assert.equal(second.id, 'custom-mine-2');
  });
});

describe('engine resolution', () => {
  let homeDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-llama-forks-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
  });

  beforeEach(async () => {
    await fs.rm(path.join(homeDir, 'llama-cpp.json'), { force: true });
    await fs.rm(path.join(homeDir, 'models-runtime'), { recursive: true, force: true });
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('an unbuilt active fork resolves to no binary, never to upstream', async () => {
    // Plant an upstream managed binary: it must not be picked while turbo3 is selected.
    await fs.mkdir(getManagedLlamaRoot(), { recursive: true });
    await fs.writeFile(path.join(getManagedLlamaRoot(), exe), '');
    await setActiveLlamaEngine('turbo3');

    const resolved = await resolveLlamaServer();
    assert.equal(resolved.path, null);
    assert.equal(resolved.engineId, 'turbo3');
    assert.match(resolved.reason ?? '', /not built/);
  });

  test('a built fork resolves to its bin/ and reports its backend variant', async () => {
    await fs.mkdir(getForkBinDir('turbo3'), { recursive: true });
    await fs.writeFile(path.join(getForkBinDir('turbo3'), exe), '');
    await setActiveLlamaEngine('turbo3');

    const resolved = await resolveLlamaServer();
    assert.equal(resolved.source, 'fork');
    assert.equal(resolved.path, path.join(getForkBinDir('turbo3'), exe));
    assert.equal(await getInstalledLlamaVariant(), 'cuda');
  });

  test('a selected engine that was deleted explains itself', async () => {
    await writeLlamaCppConfig({ engine: { active: 'custom-gone', customForks: [] } });
    const resolved = await resolveLlamaServer();
    assert.equal(resolved.path, null);
    assert.match(resolved.reason ?? '', /no longer exists/);
  });

  test('rejects an unknown engine id', async () => {
    await assert.rejects(() => setActiveLlamaEngine('nope'), /Unknown llama.cpp engine/);
  });

  test('removing the active custom fork falls back to upstream', async () => {
    const binary = path.join(homeDir, exe);
    await fs.writeFile(binary, '');
    const fork = await addCustomLlamaFork({ label: 'Local', source: 'local', binaryPath: binary, backend: 'cpu' });
    await setActiveLlamaEngine(fork.id);
    assert.equal((await resolveLlamaServer()).path, binary);

    await removeCustomLlamaFork(fork.id);
    const resolved = await resolveLlamaServer();
    assert.equal(resolved.engineId, 'upstream');
    // Removing a local fork never deletes the user's own binary.
    await fs.access(binary);
  });
});

describe('fork KV cache types', () => {
  test('parses allowed values from llama-server --help', () => {
    // Verbatim from a turbo3 build: the list wraps onto a continuation line.
    const help = [
      '-fa,   --flash-attn [on|off|auto]       set Flash Attention use',
      '-ctk,  --cache-type-k TYPE              KV cache data type for K',
      '                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1,',
      '                                        turbo2, turbo3, turbo4, turbo1.5, turbo3_tcq, turbo2_tcq',
      '                                        (default: f16)',
      '                                        (env: LLAMA_ARG_CACHE_TYPE_K)',
      '-ctv,  --cache-type-v TYPE              KV cache data type for V',
    ].join('\r\n');
    assert.deepEqual(parseLlamaCacheTypes(help), [
      'f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1',
      'turbo2', 'turbo3', 'turbo4', 'turbo1.5', 'turbo3_tcq', 'turbo2_tcq',
    ]);
    assert.deepEqual(parseLlamaCacheTypes('no such flag'), []);
  });

  test('asymmetric engines keep a mixed K/V pair; upstream coerces it', () => {
    const merged = { cache_type_k: 'q8_0', cache_type_v: 'turbo3' };
    const upstream = pairKvCacheTypes(merged);
    assert.equal(upstream.coerced, true);
    assert.equal(upstream.typeK, upstream.typeV);

    const fork = pairKvCacheTypes(merged, { asymmetricKv: true });
    assert.equal(fork.coerced, false);
    assert.equal(fork.typeK, 'q8_0');
    assert.equal(fork.typeV, 'turbo3');
  });
});
