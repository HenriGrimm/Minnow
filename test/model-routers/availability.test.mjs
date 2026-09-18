/**
 * Router availability treats My Models rows as eligible even when unloaded.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { setLibraryBindingDepsForTests } from '../../server/models/library-binding.js';
import { setLibraryServeDepsForTests } from '../../server/model-routers/library-serve.js';
import { routerAvailability } from '../../server/model-routers/availability.js';
import { setLibraryLaunchSettings } from '../../server/models/launch-prefs.js';

const LIBRARY_ID = 'gguf:qwen/Qwen3.5-9B:weights.Q4_K_M.gguf';
const GGUF_CACHED = {
  repo_id: 'qwen/Qwen3.5-9B',
  path: '/models/hub/qwen--Qwen3.5-9B',
  is_local_dir: true,
  gguf_files: [
    {
      name: 'Qwen3.5-9B.Q4_K_M.gguf',
      rel_path: 'weights.Q4_K_M.gguf',
      size_bytes: 6_000,
      role: 'model',
      quant: 'Q4_K_M',
    },
  ],
};

let home;

before(async () => {
  home = setTestHome(process.env, 'minnow-test-router-availability');
  await ensureMinnowLayout();
});

after(async () => {
  setLibraryBindingDepsForTests(null);
  setLibraryServeDepsForTests(null);
  await rmTestHome(home);
});

describe('routerAvailability My Models', () => {
  test('a cached library id is available even with no live llama catalog', async () => {
    setLibraryBindingDepsForTests({
      listCachedModels: async () => ({ models: [GGUF_CACHED] }),
      listServes: async () => [],
      findLiveLlamaCppServe: async () => null,
      findLiveMlxServe: async () => null,
      startServe: async () => {
        throw new Error('startServe should not run during availability');
      },
      getServe: async () => null,
      sleep: async () => {},
      now: () => 0,
    });
    setLibraryServeDepsForTests({
      listServes: async () => [],
      listGenerationStates: () => [],
    });
    const router = {
      id: 'r1',
      name: 'Local',
      enabled: true,
      policy: 'priority',
      entries: [
        {
          id: 'e1',
          providerId: 'minnow-library',
          modelId: LIBRARY_ID,
          enabled: true,
          concurrencyLimit: 1,
        },
      ],
    };
    const result = await routerAvailability(router, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.e1.available, true);
    assert.equal(result.e1.reason, 'Available · not loaded');
  });

  test('a missing library id is unavailable', async () => {
    setLibraryBindingDepsForTests({
      listCachedModels: async () => ({ models: [] }),
      listServes: async () => [],
      findLiveLlamaCppServe: async () => null,
      findLiveMlxServe: async () => null,
      startServe: async () => {
        throw new Error('startServe should not run during availability');
      },
      getServe: async () => null,
      sleep: async () => {},
      now: () => 0,
    });
    const router = {
      id: 'r1',
      name: 'Local',
      enabled: true,
      policy: 'priority',
      entries: [
        {
          id: 'e1',
          providerId: 'minnow-library',
          modelId: LIBRARY_ID,
          enabled: true,
          concurrencyLimit: 1,
        },
      ],
    };
    const result = await routerAvailability(router, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.e1.available, false);
    assert.equal(result.e1.reason, 'Model unavailable');
  });
  test('an image turn skips a projector model whose vision is off in load settings', async () => {
    const withProjector = {
      ...GGUF_CACHED,
      gguf_files: [
        ...GGUF_CACHED.gguf_files,
        { name: 'mmproj-F16.gguf', rel_path: 'mmproj-F16.gguf', size_bytes: 600, role: 'projector' },
      ],
    };
    setLibraryBindingDepsForTests({
      listCachedModels: async () => ({ models: [withProjector] }),
      listServes: async () => [],
      findLiveLlamaCppServe: async () => null,
      findLiveMlxServe: async () => null,
      startServe: async () => {
        throw new Error('startServe should not run during availability');
      },
      getServe: async () => null,
      sleep: async () => {},
      now: () => 0,
    });
    setLibraryServeDepsForTests({
      listServes: async () => [],
      listGenerationStates: () => [],
    });
    const router = {
      id: 'r1',
      name: 'Local',
      enabled: true,
      policy: 'priority',
      entries: [
        {
          id: 'e1',
          providerId: 'minnow-library',
          modelId: LIBRARY_ID,
          enabled: true,
          concurrencyLimit: 1,
        },
      ],
    };
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
        },
      ],
    };
    assert.equal((await routerAvailability(router, body)).e1.available, true);

    await setLibraryLaunchSettings(LIBRARY_ID, { no_mmproj: true });
    try {
      const result = await routerAvailability(router, body);
      assert.equal(result.e1.available, false);
      assert.equal(result.e1.reason, 'Vision turned off in load settings');
    } finally {
      await setLibraryLaunchSettings(LIBRARY_ID, null);
    }
  });
});
