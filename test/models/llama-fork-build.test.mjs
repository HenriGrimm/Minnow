/**
 * llama.cpp fork builds — cmake argv, CUDA arch detection, progress parsing, host support.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  applySourcePatches,
  buildCmakeArgs,
  checkForkSupport,
  parseBuildProgress,
  parseComputeCaps,
} from '../../server/models/llama-fork-build.js';
import { listApprovedForks, normalizeCustomFork } from '../../server/models/llama-forks-catalog.js';

const turbo3 = listApprovedForks().find((f) => f.id === 'turbo3');

describe('cmake arguments', () => {
  test('CUDA fork gets the backend flag, the detected arch and a lean release build', () => {
    const { configure, build } = buildCmakeArgs(turbo3, {
      sourceDir: 'src',
      buildDir: 'build',
      computeCaps: ['86', '120'],
      jobs: 8,
    });
    assert.deepEqual(configure.slice(0, 4), ['-S', 'src', '-B', 'build']);
    assert.ok(configure.includes('-DGGML_CUDA=ON'));
    assert.ok(configure.includes('-DCMAKE_CUDA_ARCHITECTURES=86;120'));
    assert.ok(configure.includes('-DLLAMA_CURL=OFF'));
    assert.ok(configure.includes('-DLLAMA_BUILD_TESTS=OFF'));
    // Multi-config generators (Visual Studio) need --config; single-config ones ignore it.
    assert.deepEqual(build, [
      '--build',
      'build',
      '--config',
      'Release',
      '--target',
      'llama-server',
      '--parallel',
      '8',
    ]);
  });

  test('falls back to native CUDA arch when nvidia-smi reported none', () => {
    const { configure } = buildCmakeArgs(turbo3, { sourceDir: 's', buildDir: 'b', computeCaps: [] });
    assert.ok(configure.includes('-DCMAKE_CUDA_ARCHITECTURES=native'));
  });

  test('user flags win over the defaults', () => {
    const fork = normalizeCustomFork({
      label: 'x',
      repo: 'a/b',
      backend: 'cuda',
      cmakeFlags: '-DCMAKE_CUDA_ARCHITECTURES=89 -DLLAMA_CURL=ON -DGGML_CUDA=OFF',
    });
    const { configure } = buildCmakeArgs(fork, { sourceDir: 's', buildDir: 'b', computeCaps: ['86'] });
    assert.ok(configure.includes('-DCMAKE_CUDA_ARCHITECTURES=89'));
    assert.ok(!configure.includes('-DCMAKE_CUDA_ARCHITECTURES=86'));
    assert.ok(configure.includes('-DLLAMA_CURL=ON'));
    assert.ok(!configure.includes('-DLLAMA_CURL=OFF'));
    assert.ok(!configure.includes('-DGGML_CUDA=ON'));
  });

  test('a CPU fork adds no backend flag and no CUDA arch', () => {
    const fork = normalizeCustomFork({ label: 'cpu', repo: 'a/b', backend: 'cpu' });
    const { configure } = buildCmakeArgs(fork, { sourceDir: 's', buildDir: 'b' });
    assert.ok(!configure.some((f) => f.startsWith('-DGGML_CUDA') || f.startsWith('-DCMAKE_CUDA')));
  });
});

describe('Windows fixes for turbo3', () => {
  test('MSVC gets _USE_MATH_DEFINES on Windows only', () => {
    const win = buildCmakeArgs(turbo3, { sourceDir: 's', buildDir: 'b', platform: 'win32' }).configure;
    const linux = buildCmakeArgs(turbo3, { sourceDir: 's', buildDir: 'b', platform: 'linux' }).configure;
    assert.ok(win.some((f) => f.startsWith('-DCMAKE_C_FLAGS=') && f.includes('/D_USE_MATH_DEFINES')));
    assert.ok(!linux.some((f) => f.startsWith('-DCMAKE_C_FLAGS=')));
  });

  test('source patches apply once and skip when the text has moved', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-fork-patch-'));
    try {
      const file = path.join(dir, 'ggml', 'src', 'ggml-cpu', 'ops.cpp');
      await fs.mkdir(path.dirname(file), { recursive: true });
      // CRLF on disk, as a Windows checkout would have it.
      await fs.writeFile(
        file,
        '#include "ops.h"\r\n\r\nvoid f() {\r\n        extern int turbo3_cpu_wht_group_size;\r\n}\r\n',
      );
      const logs = [];
      await applySourcePatches(turbo3, dir, (t) => logs.push(t), 'win32');
      const patched = await fs.readFile(file, 'utf8');
      // `extern "C"` is only legal at file scope: the local declaration moves up there.
      assert.match(patched, /^#include "ops.h"\r\n\r\n.*\r\nextern "C" int turbo3_cpu_wht_group_size;\r\n/);
      assert.doesNotMatch(patched, /^\s+extern int turbo3_cpu_wht_group_size;/m);
      assert.ok(!/[^\r]\n/.test(patched), 'line endings stay CRLF');
      assert.match(logs.join('\n'), /patched ggml\/src\/ggml-cpu\/ops.cpp/);

      // Already fixed (e.g. building the branch head): logged, not an error.
      await applySourcePatches(turbo3, dir, (t) => logs.push(t), 'win32');
      assert.match(logs.at(-1), /text not found/);

      // Other hosts and custom forks never get patched.
      const before = await fs.readFile(file, 'utf8');
      await applySourcePatches(turbo3, dir, () => {}, 'linux');
      await applySourcePatches({ ...turbo3, origin: 'custom' }, dir, () => {}, 'win32');
      assert.equal(await fs.readFile(file, 'utf8'), before);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('build progress and GPU probes', () => {
  test('reads Makefile and Ninja progress', () => {
    assert.equal(parseBuildProgress('[ 45%] Building CXX object common/arg.cpp.o'), 45);
    assert.equal(parseBuildProgress('[12/48] Building CUDA object fattn.cu.o'), 25);
    assert.equal(parseBuildProgress('  ggml.vcxproj -> ggml.lib'), null);
  });

  test('compute caps are deduplicated and sorted', () => {
    assert.deepEqual(parseComputeCaps('12.0\r\n8.6\n8.6\nnot a cap\n'), ['86', '120']);
  });

  test('turbo3 needs an SM 8.6+ NVIDIA GPU', async () => {
    if (process.platform === 'darwin') {
      const r = await checkForkSupport(turbo3, { computeCaps: [] });
      assert.equal(r.supported, false);
      return;
    }
    assert.equal((await checkForkSupport(turbo3, { computeCaps: [] })).supported, false);
    const old = await checkForkSupport(turbo3, { computeCaps: ['75'] });
    assert.equal(old.supported, false);
    assert.match(old.reason ?? '', /8\.6/);
    assert.equal((await checkForkSupport(turbo3, { computeCaps: ['75', '89'] })).supported, true);
  });
});
