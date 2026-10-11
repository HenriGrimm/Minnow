/**
 * Local model library derivation — repo rows to loadable rows.
 */

import assert from 'node:assert/strict';
import { describe, test, before } from 'node:test';
import type { CachedModelRow, ServeRecord } from '../../src/models/api-client.ts';
import {
  activeServeFor,
  buildLibrary,
  filterLibrary,
  inferArchFromName,
  inferParamsFromName,
  loadableLibrary,
  type LibraryModel,
} from '../../src/models/library.ts';

function ggufRow(overrides: Partial<CachedModelRow> = {}): CachedModelRow {
  return {
    repo_id: 'qwen/Qwen3-8B-GGUF',
    size_bytes: 5_000_000_000,
    nb_files: 2,
    has_incomplete: false,
    path: '/home/u/.minnow/models/artifacts/qwen--Qwen3-8B-GGUF',
    is_gguf: true,
    status: 'downloaded',
    gguf_files: [
      {
        name: 'Qwen3-8B-Q4_K_M.gguf',
        rel_path: 'Qwen3-8B-Q4_K_M.gguf',
        size_bytes: 4_800_000_000,
        role: 'model',
        quant: 'Q4_K_M',
      },
      {
        name: 'mmproj-Qwen3-8B.gguf',
        rel_path: 'mmproj-Qwen3-8B.gguf',
        size_bytes: 200_000_000,
        role: 'projector',
        quant: 'F16',
      },
    ],
    ...overrides,
  };
}

describe('buildLibrary', () => {
  test('emits one row per model GGUF and skips projectors', async () => {
    const rows = await buildLibrary([ggufRow()]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].format, 'GGUF');
    assert.equal(rows[0].quant, 'Q4_K_M');
    assert.equal(rows[0].name, 'Qwen3-8B-Q4_K_M');
    assert.equal(rows[0].publisher, 'qwen');
    assert.equal(rows[0].producerSlug, 'qwen');
    assert.equal(rows[0].producerName, 'Qwen');
    assert.equal(rows[0].servable, true);
  });

  test('a sibling mmproj marks the row as vision (llama-server --mmproj)', async () => {
    const rows = await buildLibrary([ggufRow()]);
    assert.ok(rows[0].capabilities.includes('vision'));
  });

  test('no projector leaves capabilities untouched', async () => {
    const row = ggufRow({
      gguf_files: [
        {
          name: 'Qwen3-8B-Q4_K_M.gguf',
          rel_path: 'Qwen3-8B-Q4_K_M.gguf',
          size_bytes: 4_800_000_000,
          role: 'model',
          quant: 'Q4_K_M',
        },
      ],
    });
    const rows = await buildLibrary([row]);
    assert.equal(rows[0].capabilities.includes('vision'), false);
  });

  test('lists every quant in a repo separately', async () => {
    const row = ggufRow({
      gguf_files: [
        { name: 'a-Q4_K_M.gguf', rel_path: 'a-Q4_K_M.gguf', size_bytes: 1, role: 'model', quant: 'Q4_K_M' },
        { name: 'a-Q8_0.gguf', rel_path: 'a-Q8_0.gguf', size_bytes: 2, role: 'model', quant: 'Q8_0' },
      ],
    });
    const rows = await buildLibrary([row]);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.quant).sort(),
      ['Q4_K_M', 'Q8_0'],
    );
    assert.equal(new Set(rows.map((r) => r.id)).size, 2, 'row ids must be unique');
  });

  test('joins a direct path for downloaded and local-dir sources', async () => {
    const rows = await buildLibrary([ggufRow()]);
    assert.equal(
      rows[0].path,
      '/home/u/.minnow/models/artifacts/qwen--Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf',
    );
  });

  test('reconstructs the hub cache layout for HF-cached weights', async () => {
    const rows = await buildLibrary([
      ggufRow({
        status: 'cached',
        path: '/home/u/.cache/huggingface/hub',
        gguf_files: [
          {
            name: 'Qwen3-8B-Q4_K_M.gguf',
            rel_path: 'abc123/Qwen3-8B-Q4_K_M.gguf',
            size_bytes: 1,
            role: 'model',
            quant: 'Q4_K_M',
          },
        ],
      }),
    ]);
    assert.equal(
      rows[0].path,
      '/home/u/.cache/huggingface/hub/models--qwen--Qwen3-8B-GGUF/snapshots/abc123/Qwen3-8B-Q4_K_M.gguf',
    );
    assert.equal(rows[0].source, 'hf-cache');
  });

  test('keeps Windows paths on one separator', async () => {
    const rows = await buildLibrary([
      ggufRow({
        status: 'cached',
        path: 'C:\\Users\\u\\.cache\\huggingface\\hub',
        gguf_files: [
          { name: 'a.gguf', rel_path: 'abc/a.gguf', size_bytes: 1, role: 'model', quant: 'Q4_K_M' },
        ],
      }),
    ]);
    assert.equal(
      rows[0].path,
      'C:\\Users\\u\\.cache\\huggingface\\hub\\models--qwen--Qwen3-8B-GGUF\\snapshots\\abc\\a.gguf',
    );
    assert.ok(!rows[0].path!.includes('/'), 'no mixed separators');
  });

  test('keeps non-GGUF repos visible but not servable', async () => {
    const rows = await buildLibrary([
      {
        repo_id: 'meta-llama/Llama-3-8B',
        size_bytes: 16_000_000_000,
        nb_files: 12,
        has_incomplete: false,
        path: '/home/u/.cache/huggingface/hub',
        status: 'cached',
      },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].format, 'SafeTensors');
    assert.equal(rows[0].servable, false);
    assert.equal(rows[0].path, null);
  });

  test('does not claim a quant for a repo with no weights file on disk', async () => {
    const rows = await buildLibrary([
      { ...ggufRow(), is_gguf: false, gguf_files: [] },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quant, '');
    assert.equal(rows[0].servable, false);
  });

  test('Ollama tags are not listed as loadable My Models rows', async () => {
    const rows = await buildLibrary([
      {
        repo_id: 'llama3:8b',
        size_bytes: 4_700_000_000,
        nb_files: 1,
        has_incomplete: false,
        path: 'ollama',
        is_ollama: true,
        status: 'ollama',
      },
    ]);
    assert.equal(rows[0].format, 'Ollama');
    assert.equal(rows[0].publisher, 'ollama');
    assert.equal(rows[0].servable, false);
    assert.equal(loadableLibrary(rows).length, 0);
  });

  test('flags incomplete downloads', async () => {
    const rows = await buildLibrary([ggufRow({ has_incomplete: true })]);
    assert.equal(rows[0].incomplete, true);
  });

  test('uses mlx_context_length from the scan for MLX rows', async () => {
    const rows = await buildLibrary([
      {
        repo_id: 'mlx-community/SmolLM2-360M-Instruct-4bit',
        size_bytes: 200_000_000,
        nb_files: 3,
        has_incomplete: false,
        path: '/home/u/.minnow/models/artifacts/mlx-community--SmolLM2-360M-Instruct-4bit',
        status: 'downloaded',
        mlx_root: '/home/u/.minnow/models/artifacts/mlx-community--SmolLM2-360M-Instruct-4bit',
        mlx_quant: 'mlx-4bit',
        mlx_context_length: 8192,
      },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].format, 'MLX');
    assert.equal(rows[0].contextLength, 8192);
  });

  test('marks MTPLX rows with a vision tower as vision-capable', async () => {
    const mtplxRow = (repo_id: string, mtplx_vision?: boolean): CachedModelRow => ({
      repo_id,
      size_bytes: 20_000_000_000,
      nb_files: 4,
      has_incomplete: false,
      path: `/home/u/.mtplx/models/${repo_id.replace('/', '--')}`,
      mlx_root: `/home/u/.mtplx/models/${repo_id.replace('/', '--')}`,
      mlx_quant: 'mlx-4bit',
      mtplx_root: `/home/u/.mtplx/models/${repo_id.replace('/', '--')}`,
      mtplx_validated: true,
      ...(mtplx_vision ? { mtplx_vision } : {}),
    });
    const rows = await buildLibrary([mtplxRow('Org/Vlm-MTPLX', true), mtplxRow('Org/Text-MTPLX')]);
    const byRepo = new Map(rows.map((r) => [r.repoId, r]));
    assert.ok(byRepo.get('Org/Vlm-MTPLX')?.capabilities.includes('vision'));
    assert.ok(!byRepo.get('Org/Text-MTPLX')?.capabilities.includes('vision'));
  });

  test('resolves maker from the weight name when the repo publisher is a quantizer', async () => {
    const rows = await buildLibrary([
      ggufRow({
        repo_id: 'lmstudio-community/Qwen3.5-9B-GGUF',
        path: '/models/lms',
        gguf_files: [
          {
            name: 'Qwen3.5-9B-Q4_K_M.gguf',
            rel_path: 'Qwen3.5-9B-Q4_K_M.gguf',
            size_bytes: 5e9,
            role: 'model',
            quant: 'Q4_K_M',
          },
        ],
      }),
    ]);
    assert.equal(rows[0].publisher, 'lmstudio-community');
    assert.equal(rows[0].producerSlug, 'qwen');
    assert.equal(rows[0].producerName, 'Qwen');
  });
});

describe('loadableLibrary', () => {
  test('drops non-servable scan rows', async () => {
    const all = await buildLibrary([
      ggufRow(),
      {
        repo_id: 'meta-llama/Llama-3-8B',
        size_bytes: 16_000_000_000,
        nb_files: 12,
        has_incomplete: false,
        path: '/home/u/.cache/huggingface/hub',
        status: 'cached',
      },
    ]);
    const rows = loadableLibrary(all);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].format, 'GGUF');
  });
});

describe('filterLibrary', () => {
  let models: LibraryModel[];
  before(async () => {
    models = await buildLibrary([
      ggufRow(),
      ggufRow({
        repo_id: 'google/gemma-3-27b-GGUF',
        path: '/models/gemma',
        is_local_dir: true,
        status: 'local',
        gguf_files: [
          { name: 'gemma-3-27b-Q8_0.gguf', rel_path: 'gemma-3-27b-Q8_0.gguf', size_bytes: 29e9, role: 'model', quant: 'Q8_0' },
        ],
      }),
    ]);
  });

  test('matches name, repo, quant, and arch', () => {
    assert.equal(filterLibrary(models, { search: 'gemma' }).length, 1);
    assert.equal(filterLibrary(models, { search: 'Q4_K_M' }).length, 1);
    assert.equal(filterLibrary(models, { search: 'nothing-here' }).length, 0);
  });

  test('filters by publisher', () => {
    const rows = filterLibrary(models, { publisher: 'google' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].publisher, 'google');
  });

  test('filters by maker slug', () => {
    const rows = filterLibrary(models, { producer: 'google' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].producerSlug, 'google');
  });

  test('sorts largest first', () => {
    const rows = filterLibrary(models, { listSort: { key: 'size', direction: 'desc' } });
    assert.ok(rows[0].sizeBytes >= rows[1].sizeBytes);
  });
});

describe('activeServeFor', () => {
  let model: LibraryModel;
  before(async () => {
    model = (await buildLibrary([ggufRow()]))[0];
  });

  function serve(overrides: Partial<ServeRecord> = {}): ServeRecord {
    return {
      id: 's1',
      runtime: 'llama-cpp',
      modelPath: model.path!,
      modelLabel: model.name,
      port: 8085,
      baseUrl: 'http://127.0.0.1:8085',
      providerId: 'llama-cpp-local',
      status: 'running',
      runId: null,
      pid: null,
      error: null,
      startedAt: 0,
      stoppedAt: null,
      ...overrides,
    };
  }

  test('matches a running serve by model path', () => {
    assert.ok(activeServeFor(model, [serve()]));
  });

  test('ignores stopped serves', () => {
    assert.equal(activeServeFor(model, [serve({ status: 'stopped' })]), undefined);
  });
});

describe('name inference', () => {
  test('reads a parameter count out of a file name', () => {
    assert.equal(inferParamsFromName('Qwen3-8B-Q4_K_M'), 8);
    assert.equal(inferParamsFromName('gemma-3-27b-it'), 27);
    assert.equal(inferParamsFromName('no-params-here'), null);
  });

  test('guesses a family from a model name', () => {
    assert.equal(inferArchFromName('Qwen3-8B'), 'qwen');
    assert.equal(inferArchFromName('gpt-oss-120b'), 'gpt_oss');
    assert.equal(inferArchFromName('something-unknown'), '');
  });
});
