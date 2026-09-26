/**
 * Ghost completion and intent coding resolve their binding through
 * resolveEditorAiBinding. A My Models row must arrive at the request as the
 * running serve's provider/model, and an unloaded one must fail loudly instead
 * of being routed to whatever provider sorts first.
 *
 * Do not statically import the module under test — ES import hoisting would load
 * it before mock.module runs.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import { Window } from 'happy-dom';

import type { CachedModelRow, ServeRecord } from '../../src/models/api-client.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { MLX_LM_LOCAL_PROVIDER_ID } from '../../src/providers/types.ts';

const LIBRARY_PROVIDER_ID = 'minnow-library';
const MLX_SNAPSHOT = '/models/hub/mlx-community--Ornith-35B/snapshots/abc123';

const MLX_ROW: CachedModelRow = {
  repo_id: 'mlx-community/Ornith-35B-4bit',
  size_bytes: 20_000,
  nb_files: 4,
  has_incomplete: false,
  path: '/models/hub/mlx-community--Ornith-35B',
  mlx_root: MLX_SNAPSHOT,
  mlx_quant: 'mlx-4bit',
  mlx_context_length: 32_768,
};

const MLX_LIBRARY_ID = `mlx:${MLX_ROW.repo_id}`;

let serves: ServeRecord[] = [];

const runningServe = (): ServeRecord => ({
  id: 'serve-1',
  runtime: 'mlx-lm',
  modelPath: MLX_SNAPSHOT,
  modelLabel: 'Ornith-35B-4bit',
  port: 8086,
  baseUrl: 'http://127.0.0.1:8086',
  providerId: MLX_LM_LOCAL_PROVIDER_ID,
  status: 'running',
  runId: null,
  pid: 1,
  error: null,
  startedAt: 1,
  stoppedAt: null,
});

// Incomplete namedExports replace the whole module, and the editor binding graph
// reaches the Models settings section — stub every value export it can touch.
mock.module('../../src/models/api-client.ts', {
  namedExports: {
    fetchCachedModels: async (): Promise<CachedModelRow[]> => [MLX_ROW],
    listModelServes: async (): Promise<ServeRecord[]> => serves,
    fetchModelsPing: async () => true,
    searchHubModels: async () => ({ results: [], total: 0 }),
    startModelDownload: async () => ({}),
    subscribeDownloadProgress: () => () => undefined,
    cancelModelDownload: async () => ({}),
    controlModelDownload: async () => ({}),
    fetchHubFiles: async () => ({}),
    listModelDownloads: async () => [],
    fetchInstalledModels: async () => [],
    fetchRuntimes: async () => ({}),
    fetchGgufGeometry: async () => null,
    fetchModelsConfig: async () => ({}),
    saveModelsConfig: async () => ({}),
    fetchServeProfiles: async () => [],
    fetchLlamaRuntime: async () => ({ installed: false }),
    installLlamaRuntime: async () => ({}),
    subscribeLlamaInstallProgress: () => () => undefined,
    startModelServe: async () => ({}),
    stopModelServe: async () => ({}),
    fetchModelServe: async () => null,
    fetchServeLog: async () => ({ lines: [] }),
    LLAMA_ENGINE_CHANGED_EVENT: 'minnow:llama-engine-changed',
    subscribeServeLog: () => () => undefined,
    subscribeServeEvents: () => () => undefined,
    subscribeServeActivity: () => () => undefined,
    resolveDownloadRepo: () => null,
  },
});

mock.module('../../src/models/hardware-client.ts', {
  namedExports: {
    fetchHardware: async () => ({ backend: 'metal' }),
  },
});

// Everything that transitively reaches the mocked modules must be imported after
// mock.module — a hoisted static import would load the real graph first.
const { resolveEditorAiBinding, validateEditorAiBinding } = await import(
  '../../src/ui/editor-ai-binding.ts'
);
const { LIBRARY_MODEL_NOT_LOADED_MESSAGE } = await import(
  '../../src/models/library-request-binding.ts'
);
const { DEFAULT_EDITOR_AI_COMPLETION } = await import(
  '../../src/config/editor-ai-completion.ts'
);
const { createEmptyChatObject, setSessionStateForTests } = await import(
  '../../src/state/sessions.ts'
);

const CONFIG = { ...DEFAULT_EDITOR_AI_COMPLETION, useChatModel: true };

function mountTopBarSelect(value: string): void {
  const window = new Window();
  const document = window.document;
  const select = document.createElement('select');
  select.id = 'modelSelect';
  const option = document.createElement('option');
  option.value = value;
  select.appendChild(option);
  select.value = value;
  document.body.appendChild(select);
  Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement });
}

beforeEach(() => {
  setStorageModeForTests('server');
  // Chat binding must stay empty so the top-bar select is what gets resolved.
  const chat = createEmptyChatObject('');
  chat.modelId = '';
  setSessionStateForTests({ chats: [chat], activeId: chat.id });
  mountTopBarSelect(encodeModelSelectKey(LIBRARY_PROVIDER_ID, MLX_LIBRARY_ID));
});

describe('resolveEditorAiBinding — My Models rows', () => {
  test('remaps a served row onto mlx-lm-local and the snapshot path', async () => {
    serves = [runningServe()];
    const binding = await resolveEditorAiBinding(CONFIG);
    assert.equal(binding.providerId, MLX_LM_LOCAL_PROVIDER_ID);
    assert.equal(binding.modelId, MLX_SNAPSHOT);
    assert.equal(binding.error, undefined);
    assert.deepEqual(validateEditorAiBinding(binding), { ok: true });
  });

  test('refuses an unloaded row rather than routing it elsewhere', async () => {
    serves = [];
    const binding = await resolveEditorAiBinding(CONFIG);
    // Editor AI never auto-loads: a keystroke must not start a weight load.
    assert.equal(binding.error, LIBRARY_MODEL_NOT_LOADED_MESSAGE);
    const validation = validateEditorAiBinding(binding);
    assert.equal(validation.ok, false);
    assert.equal(
      validation.ok === false ? validation.message : '',
      LIBRARY_MODEL_NOT_LOADED_MESSAGE,
    );
  });

  test('leaves a normal provider binding untouched', async () => {
    serves = [];
    mountTopBarSelect(encodeModelSelectKey('lm-studio-local', 'qwen3.5-9b'));
    const binding = await resolveEditorAiBinding(CONFIG);
    assert.deepEqual(binding, {
      providerId: 'lm-studio-local',
      modelId: 'qwen3.5-9b',
    });
  });
});
