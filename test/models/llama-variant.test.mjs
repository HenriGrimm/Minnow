/**
 * llama.cpp variant asset resolution tests.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  detectPreferredLlamaVariant,
  expectedAssetNames,
  githubReleaseHeaders,
  listInstallableVariants,
  llamaReleaseDownloadUrl,
  parseExpandedAssetsHtml,
  resolveLlamaAssets,
  isGpuCapableVariant,
  resetLlamaVariantCacheForTests,
} from '../../server/models/llama-variant.js';
import { LLAMA_CPP_RELEASE_TAG } from '../../server/models/llama-runtime.js';

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const MOCK_ASSETS =
  process.platform === 'win32'
    ? [
        { name: `llama-${LLAMA_CPP_RELEASE_TAG}-bin-win-cpu-${arch}.zip` },
        { name: `llama-${LLAMA_CPP_RELEASE_TAG}-bin-win-cuda-12.4-${arch}.zip` },
        { name: `cudart-llama-bin-win-cuda-12.4-${arch}.zip` },
        { name: `llama-${LLAMA_CPP_RELEASE_TAG}-bin-win-vulkan-${arch}.zip` },
      ]
    : process.platform === 'darwin' && process.arch === 'arm64'
      ? [
          { name: `llama-${LLAMA_CPP_RELEASE_TAG}-bin-macos-arm64.tar.gz` },
          { name: `llama-${LLAMA_CPP_RELEASE_TAG}-bin-macos-${arch}.tar.gz` },
        ]
      : [
          { name: `llama-${LLAMA_CPP_RELEASE_TAG}-bin-ubuntu-${arch}.tar.gz` },
          { name: `llama-${LLAMA_CPP_RELEASE_TAG}-bin-ubuntu-cuda-12.4-${arch}.tar.gz` },
          { name: `llama-${LLAMA_CPP_RELEASE_TAG}-bin-ubuntu-vulkan-${arch}.tar.gz` },
          { name: `llama-${LLAMA_CPP_RELEASE_TAG}-bin-ubuntu-rocm-${arch}.tar.gz` },
        ];

afterEach(() => {
  resetLlamaVariantCacheForTests();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

describe('llama variant', () => {
  test('expectedAssetNames returns CPU asset on Windows x64', () => {
    if (process.platform !== 'win32' || process.arch !== 'x64') return;
    const names = expectedAssetNames('cpu', LLAMA_CPP_RELEASE_TAG);
    assert.equal(names.main, `llama-${LLAMA_CPP_RELEASE_TAG}-bin-win-cpu-x64.zip`);
  });

  test('resolveLlamaAssets picks CUDA main + cudart companion on Windows', () => {
    if (process.platform !== 'win32') return;
    const resolved = resolveLlamaAssets({
      variant: 'cuda-12.4',
      tag: LLAMA_CPP_RELEASE_TAG,
      assets: MOCK_ASSETS,
    });
    assert.match(resolved.mainZip, /cuda-12\.4/);
    assert.ok(resolved.companionZip?.startsWith('cudart-'));
    assert.equal(resolved.assetNames.length, 2);
  });

  test('cuda-13 picker stays on the host arch when a newer other-arch zip exists', () => {
    if (process.platform !== 'win32') return;
    // b10448 published 13.3 for x64 and a newer 13.4 only for arm64. A global
    // cuda-13* sort() installed the ARM64 zip on AMD64 and left a 0-byte serve log.
    const resolved = resolveLlamaAssets({
      variant: 'cuda-13',
      tag: 'b10448',
      assets: [
        { name: 'llama-b10448-bin-win-cuda-13.3-x64.zip' },
        { name: 'llama-b10448-bin-win-cuda-13.4-arm64.zip' },
        { name: 'cudart-llama-bin-win-cuda-13.3-x64.zip' },
        { name: 'cudart-llama-bin-win-cuda-13.4-arm64.zip' },
        { name: 'llama-b10448-bin-ubuntu-x64-cuda-13.4.tar.gz' },
      ],
    });
    const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
    assert.match(resolved.mainZip, new RegExp(`${hostArch}\\.zip$`));
    assert.equal(resolved.mainZip.includes('arm64'), hostArch === 'arm64');
    assert.equal(resolved.companionZip?.includes(hostArch), true);
    if (hostArch === 'x64') {
      assert.equal(resolved.mainZip, 'llama-b10448-bin-win-cuda-13.3-x64.zip');
      assert.equal(resolved.companionZip, 'cudart-llama-bin-win-cuda-13.3-x64.zip');
    } else {
      assert.equal(resolved.mainZip, 'llama-b10448-bin-win-cuda-13.4-arm64.zip');
      assert.equal(resolved.companionZip, 'cudart-llama-bin-win-cuda-13.4-arm64.zip');
    }
  });

  test('listInstallableVariants filters by manifest', () => {
    const variants = listInstallableVariants(MOCK_ASSETS);
    assert.ok(variants.includes('cpu'));
    if (process.platform === 'win32') {
      assert.ok(variants.includes('cuda-12.4'));
      assert.ok(variants.includes('vulkan'));
    }
  });

  test('isGpuCapableVariant distinguishes CPU from CUDA', () => {
    assert.equal(isGpuCapableVariant('cpu'), false);
    assert.equal(isGpuCapableVariant('cuda-12.4'), true);
  });

  test('detectPreferredLlamaVariant prefers CUDA when hardware.backend is cuda', async () => {
    if (process.platform === 'darwin') return;
    const variant = await detectPreferredLlamaVariant({ backend: 'cuda' }, MOCK_ASSETS);
    assert.equal(variant, 'cuda-12.4');
  });

  test('detectPreferredLlamaVariant falls back to Vulkan without CUDA backend', async () => {
    if (process.platform === 'darwin') return;
    const variant = await detectPreferredLlamaVariant({ backend: 'cpu_x86' }, MOCK_ASSETS);
    assert.equal(variant, 'vulkan');
  });

  test('githubReleaseHeaders attaches Bearer from GITHUB_TOKEN', () => {
    process.env.GITHUB_TOKEN = 'ghs_test_fixed_token';
    const headers = githubReleaseHeaders();
    assert.equal(headers.Authorization, 'Bearer ghs_test_fixed_token');
    assert.equal(headers['User-Agent'], 'minnow-llama-runtime');
  });

  test('githubReleaseHeaders prefers GITHUB_TOKEN over GH_TOKEN', () => {
    process.env.GITHUB_TOKEN = 'ghs_primary';
    process.env.GH_TOKEN = 'ghs_secondary';
    assert.equal(githubReleaseHeaders().Authorization, 'Bearer ghs_primary');
  });

  test('parseExpandedAssetsHtml extracts downloadable zips for the tag', () => {
    const html = `
      <a href="/ggml-org/llama.cpp/releases/download/b10448/llama-b10448-bin-win-cpu-x64.zip">cpu</a>
      <a href="/ggml-org/llama.cpp/releases/download/b10448/cudart-llama-bin-win-cuda-12.4-x64.zip">cudart</a>
      <a href="/ggml-org/llama.cpp/releases/download/b99999/llama-b99999-bin-win-cpu-x64.zip">other tag</a>
      <a href="/ggml-org/llama.cpp/releases/download/b10448/llama-b10448-bin-win-cpu-x64.zip.sha256">checksum</a>
    `;
    const assets = parseExpandedAssetsHtml(html, 'b10448');
    assert.deepEqual(
      assets.map((a) => a.name),
      [
        'cudart-llama-bin-win-cuda-12.4-x64.zip',
        'llama-b10448-bin-win-cpu-x64.zip',
      ],
    );
    assert.equal(
      assets[1].browser_download_url,
      llamaReleaseDownloadUrl('b10448', 'llama-b10448-bin-win-cpu-x64.zip'),
    );
    assert.equal(assets[0].digest, undefined);
  });
});
