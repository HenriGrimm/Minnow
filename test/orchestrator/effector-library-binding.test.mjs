/**
 * V2 runner must remap minnow-library before getProvider / runTurn.
 *
 * A seeded llama-cpp-local profile plus a fake live serve is enough — we do
 * not spawn llama-server. The journaled board chip stays the picker id.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';

import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import {
  ensureMinnowLayout,
  getMinnowHome,
  resetMinnowHomeCache,
} from '../../server/config/home.js';
import {
  LIBRARY_MODEL_NOT_LOADED_MESSAGE,
  setLibraryBindingDepsForTests,
} from '../../server/models/library-binding.js';
import { createRunnerEffector } from '../../server/orchestrator/effector-runner.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { createMemoryJournal } from '../../server/orchestrator/testing/memory-journal.js';
import {
  ensureProviderRegistry,
  createProvider,
  getProvider,
  getProviderRuntime,
  LLAMA_CPP_LOCAL_ID,
  MLX_LM_LOCAL_ID,
  MTPLX_LOCAL_ID,
} from '../../server/providers/store.js';

const LIBRARY_PROVIDER = 'minnow-library';
const GGUF_LIBRARY_ID = 'gguf:qwen/Qwen3.5-9B:weights.Q4_K_M.gguf';
const GGUF_PATH = '/models/hub/qwen--Qwen3.5-9B/weights.Q4_K_M.gguf';

const BUILDER_PASS = {
  outcome: 'pass',
  summary: 'Built.',
  evidence: ['src/a.ts'],
};

function taskSpec() {
  return {
    id: 'W1-A',
    title: 'One task',
    wave: 1,
    dependsOn: [],
    touches: ['src/W1-A/**'],
    build: 'build it',
    test: 'test it',
    accept: 'it works',
  };
}

async function openBoard(boardId) {
  const journal = createMemoryJournal();
  await journal.createBoard(boardId);
  await journal.appendEvent(
    boardId,
    makeEvent('board.created', {
      boardId,
      planPath: 'plan.md',
      tasks: [taskSpec()],
      waves: [],
    }),
  );
  return journal;
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting');
}

function fakeLiveGgufDeps() {
  return {
    findLiveLlamaCppServe: async () => ({
      id: 'serve-gguf',
      runtime: 'llama-cpp',
      status: 'running',
      modelLabel: 'Qwen3.5-9B',
      modelPath: GGUF_PATH,
      libraryId: GGUF_LIBRARY_ID,
    }),
    findLiveMlxServe: async () => null,
    listServes: async () => [],
    listCachedModels: async () => ({ models: [] }),
    startServe: async () => {
      throw new Error('startServe should not be called');
    },
    getServe: async () => null,
    sleep: async () => {},
    now: () => 0,
    loadTimeoutMs: 10_000,
  };
}

describe('V2 runner My Models binding', { concurrency: false }, () => {
  /** @type {string} */
  let homeDir = '';
  /** @type {string} */
  let cwd = '';

  before(async () => {
    homeDir = setTestHome(process.env, 'minnow-test-v2-lib-bind');
    await ensureMinnowLayout();
    await ensureProviderRegistry();
    for (const id of [MLX_LM_LOCAL_ID, MTPLX_LOCAL_ID]) {
      await createProvider({ id, label: id, baseUrl: 'http://127.0.0.1:18999', apiKind: 'openai-v1' });
    }
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'v2-lib-bind-cwd-'));
  });

  afterEach(() => {
    setLibraryBindingDepsForTests(null);
  });

  after(async () => {
    setLibraryBindingDepsForTests(null);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    await rmTestHome(homeDir);
    resetMinnowHomeCache();
  });

  for (const target of [
    {
      runtime: 'llama-cpp', libraryId: GGUF_LIBRARY_ID,
      modelPath: GGUF_PATH, modelLabel: 'Qwen3.5-9B',
      cached: {
        repo_id: 'qwen/Qwen3.5-9B', path: path.dirname(GGUF_PATH), is_local_dir: true,
        gguf_files: [{ rel_path: 'weights.Q4_K_M.gguf', role: 'model', size_bytes: 6000 }],
      },
    },
    {
      runtime: 'mlx-lm', libraryId: 'mlx:mlx-community/Qwen',
      modelPath: '/models/mlx/Qwen', modelLabel: '/models/mlx/Qwen',
      cached: { repo_id: 'mlx-community/Qwen', mlx_root: '/models/mlx/Qwen' },
    },
    {
      runtime: 'mtplx', libraryId: 'mtplx:Youssofal/Qwen',
      modelPath: '/models/mtplx/Qwen', modelLabel: 'Youssofal/Qwen',
      cached: { repo_id: 'Youssofal/Qwen', mtplx_root: '/models/mtplx/Qwen', mtplx_validated: true },
    },
  ]) {
    for (const loaded of [true, false]) {
      test(`production recovery preflight remaps ${target.runtime} (${loaded ? 'running' : 'unloaded after restart'})`, async () => {
        const boardId = `recovery-${target.runtime}-${loaded}`;
        const journal = await openBoard(boardId);
        await journal.appendEvents(boardId, [
          makeEvent('board.model.set', { providerId: LIBRARY_PROVIDER, id: target.libraryId }),
          makeEvent('board.started', { concurrency: 1, recoveryVersion: 1 }),
        ]);
        let state = await journal.loadState(boardId);
        const serve = {
          id: 'recovery-serve', runtime: target.runtime, status: 'running',
          modelLabel: target.modelLabel, modelPath: target.modelPath, libraryId: target.libraryId,
        };
        const starts = [];
        setLibraryBindingDepsForTests({
          ...fakeLiveGgufDeps(),
          findLiveLlamaCppServe: async () => null,
          listServes: async () => loaded ? [serve] : [],
          listCachedModels: async () => ({ models: [target.cached] }),
          startServe: async (body) => { starts.push(body); return serve; },
        });
        // Use the production turn runner: injecting runTurn bypasses the
        // recovery provider/auth checks that regressed. No generation is sent.
        const effector = createRunnerEffector({ boardId, journal, getState: () => state, cwd, promptVariant: 'lite' });
        await effector.preflight();
        assert.equal(starts.length, loaded ? 0 : 1);
        if (!loaded) {
          assert.equal(starts[0].libraryId, target.libraryId);
          assert.equal(starts[0].runtime, target.runtime);
        }
        assert.deepEqual(state.model, { providerId: LIBRARY_PROVIDER, id: target.libraryId, reasoning: null });

        // A board model change is read fresh by the same effector.
        await journal.appendEvent(boardId, makeEvent('board.model.set', { providerId: 'lm-studio-local', id: 'other-model' }));
        state = await journal.loadState(boardId);
        await effector.preflight();
        assert.equal(starts.length, loaded ? 0 : 1);
      });
    }
  }

  test('runTurn receives llama-cpp-local and never opens minnow-library/profile.json', async () => {
    setLibraryBindingDepsForTests(fakeLiveGgufDeps());

    const boardId = 'v2-lib-remap';
    const journal = await openBoard(boardId);
    const state = await journal.loadState(boardId);
    /** @type {{ providerId?: string, id?: string } | null} */
    let seenModel = null;
    /** @type {string[]} */
    const resolvedIds = [];

    const effector = createRunnerEffector({
      boardId,
      journal,
      getState: () => state,
      model: { providerId: LIBRARY_PROVIDER, id: GGUF_LIBRARY_ID },
      cwd,
      promptVariant: 'lite',
      runTurn: async (opts) => {
        seenModel = opts.model;
        resolvedIds.push(opts.model.providerId);
        await opts.deps.resolveProvider(opts.model.providerId);
        return BUILDER_PASS;
      },
    });

    await effector.start({
      taskId: 'W1-A',
      role: 'builder',
      seedKind: 'initial',
      sameWorktree: false,
    });
    await waitFor(() => seenModel != null);
    await waitFor(() => effector.inspect().length === 0);

    assert.equal(seenModel?.providerId, LLAMA_CPP_LOCAL_ID);
    assert.equal(seenModel?.id, 'Qwen3.5-9B');
    assert.deepEqual(resolvedIds, [LLAMA_CPP_LOCAL_ID]);

    const syntheticProfile = path.join(
      getMinnowHome(),
      'providers',
      LIBRARY_PROVIDER,
      'profile.json',
    );
    await assert.rejects(fs.access(syntheticProfile), { code: 'ENOENT' });
  });

  test('preflight throws the not-loaded message, not ENOENT, when the library row is missing', async () => {
    setLibraryBindingDepsForTests({
      ...fakeLiveGgufDeps(),
      findLiveLlamaCppServe: async () => null,
    });

    const effector = createRunnerEffector({
      cwd,
      model: { providerId: LIBRARY_PROVIDER, id: GGUF_LIBRARY_ID },
      promptVariant: 'lite',
      runTurn: async () => BUILDER_PASS,
    });

    await assert.rejects(
      () => effector.preflight(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, LIBRARY_MODEL_NOT_LOADED_MESSAGE);
        assert.equal(err.message.includes('ENOENT'), false);
        return true;
      },
    );
  });

  test('getProvider throws a clear error instead of ENOENT', async () => {
    await assert.rejects(
      () => getProvider(LIBRARY_PROVIDER),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /synthetic My Models id/i);
        assert.equal(err.message.includes('ENOENT'), false);
        return true;
      },
    );
  });

  test('getProviderRuntime throws the same clear error', async () => {
    await assert.rejects(
      () => getProviderRuntime(LIBRARY_PROVIDER),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /synthetic My Models id/i);
        return true;
      },
    );
  });
});
