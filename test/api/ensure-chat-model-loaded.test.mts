/**
 * Chat turn model ensure-load — provider-scoped cache + My Models serve path.
 *
 * Library ensure uses mock.module so we do not boot serves or the full picker UI.
 * Run with --experimental-test-module-mocks (default for .test.mts via test-config).
 *
 * Important: do not statically import ensure-chat-model-loaded — ES import hoisting
 * would load it before mock.module runs and the mocks would never apply.
 * Incomplete namedExports replace the whole module — stub every export importers need.
 */
import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { modelCache } from '../../src/app-state.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';

const LIBRARY_PROVIDER_ID = 'minnow-library';
const LIBRARY_MODEL_ID = 'gguf:org/repo:weights.gguf';

/** Calls recorded by mocked loadLibraryModelFromPicker. */
const loadLibraryCalls: string[] = [];
/** Calls recorded by mocked fetchModels. */
let fetchModelsCallCount = 0;

mock.module('../../src/models/model-select-library.ts', {
  namedExports: {
    LIBRARY_MODEL_PROVIDER_ID: LIBRARY_PROVIDER_ID,
    LIBRARY_MODEL_OPTGROUP_LABEL: 'My Models',
    isLibraryModelProviderId: (providerId: string | undefined) =>
      providerId?.trim() === LIBRARY_PROVIDER_ID,
    isLocalRuntimeCatalogProviderId: (providerId: string | undefined) =>
      providerId?.trim() === 'llama-cpp-local' || providerId?.trim() === 'mlx-lm-local',
    isLibraryModelBinding: (providerId: string | undefined, modelId: string | undefined) => {
      const pid = providerId?.trim();
      const mid = modelId?.trim();
      if (!pid || !mid) return false;
      return (
        pid === LIBRARY_PROVIDER_ID && (mid.startsWith('gguf:') || mid.startsWith('mlx:'))
      );
    },
    loadableLibraryFromCached: async () => [],
    resolveUpstreamProviderId: (providerId: string | undefined) => providerId?.trim() ?? '',
    encodeLibraryModelSelectKey: (libraryId: string) =>
      encodeModelSelectKey(LIBRARY_PROVIDER_ID, libraryId),
    decodeLibraryModelSelectKey: () => null,
    libraryModelLoadState: () => 'not loaded',
    activeServeForLibraryId: () => undefined,
    servedContextLength: () => undefined,
    resolveServedBindingForLibraryId: () => null,
    libraryModelNeedsLoad: () => true,
    libraryBindingNeedsServeLoad: () => true,
    resolveLibraryModelIdForChatBinding: () => null,
    resolveLibrarySendBinding: () => null,
    omitLocalRuntimeCatalogModels: <T,>(results: T) => results,
    fetchLibraryModelSelectMerge: async () => null,
    loadLibraryModelFromPicker: async (libraryId: string) => {
      loadLibraryCalls.push(libraryId);
    },
    unloadLibraryModelFromPicker: async () => undefined,
  },
});

mock.module('../../src/api/models.ts', {
  namedExports: {
    modelCache,
    contextLengthFromModelRow: () => undefined,
    isModelLoaded: (state?: string | null) => state === 'loaded',
    getModelRowForSelectOrCanonicalId: () => undefined,
    resolveModelInfo: () => ({}),
    showCachedModelInfo: () => undefined,
    syncModelOptionLoadUnloadButtonElement: () => undefined,
    updateModelLoadUnloadButtons: () => undefined,
    loadModel: async () => undefined,
    unloadModel: async () => undefined,
    loadModelForSelectValue: async () => undefined,
    loadSelectedModel: async () => undefined,
    unloadModelForSelectValue: async () => undefined,
    unloadSelectedModel: async () => undefined,
    toggleModelLoadForSelectValue: async () => undefined,
    toggleSelectedModelLoad: async () => undefined,
    populateMultiProviderModelSelect: async () => null,
    fetchModels: async () => {
      fetchModelsCallCount += 1;
    },
    selectProviderModel: async () => undefined,
  },
});

mock.module('../../src/ui/model-load-unload-button.ts', {
  namedExports: {
    beginModelLoadUnload: () => undefined,
    endModelLoadUnload: () => undefined,
    isModelLoadUnloadBusy: () => false,
    getModelLoadUnloadPhase: () => null,
    setModelLoadUnloadButtonBusy: () => undefined,
    setModelLoadUnloadButtonIdle: () => undefined,
    setModelLoadUnloadButtonUnsupported: () => undefined,
    setModelLoadUnloadIconButtonBusy: () => undefined,
    setModelLoadUnloadIconButtonIdle: () => undefined,
    setModelLoadUnloadIconButtonUnsupported: () => undefined,
  },
});

mock.module('../../src/ui/model-state-dot.ts', {
  namedExports: {
    updateModelStateDot: () => undefined,
    isModelLoaded: (record?: { state?: string } | null) => record?.state === 'loaded',
    resolveModelState: () => 'unknown' as const,
  },
});

mock.module('../../src/ui/model-select-picker.ts', {
  namedExports: {
    registerModelSelectExternalCloser: () => () => undefined,
    getModelHostFilter: () => 'all' as const,
    setModelHostFilter: () => undefined,
    getModelLocalLoadFilter: () => 'all' as const,
    setModelLocalLoadFilter: () => undefined,
    toggleModelLocalLoadFilter: () => 'all' as const,
    getModelLibraryFilter: () => 'all' as const,
    setModelLibraryFilter: () => undefined,
    toggleModelLibraryFilter: () => 'all' as const,
    getModelSearchQuery: () => '',
    setModelSearchQuery: () => undefined,
    clearModelSearchQuery: () => undefined,
    focusModelHostFilterSearch: () => undefined,
    mountModelHostFilterBar: () => undefined,
    mountModelMenuActions: () => undefined,
    openModelLoadSettings: async () => undefined,
    closeModelSelectMenu: () => undefined,
    shouldKeepModelMenuOpenAfterSelect: () => false,
    selectModelInPicker: () => undefined,
    syncAuxiliaryModelSelectCombobox: () => undefined,
    mountAuxiliaryModelSelectCombobox: () => undefined,
    renderModelSelectMenuRows: () => '',
    syncModelSelectPicker: () => undefined,
    initModelSelectPicker: () => undefined,
  },
});

describe('ensure-chat-model-loaded', () => {
  test('chatTurnNeedsModelLoad uses provider-scoped cache rows only', async () => {
    setStorageModeForTests('server');
    modelCache.clear();
    const provider = {
      id: 'lm-local',
      name: 'LM Studio',
      apiKind: 'lm-studio-v0',
      enabled: true,
    };
    const topBarKey = encodeModelSelectKey('lm-local', 'top-bar-model');
    const chatKey = encodeModelSelectKey('lm-local', 'chat-model');
    modelCache.set(topBarKey, { id: 'top-bar-model', state: 'loaded' });
    modelCache.set(chatKey, { id: 'chat-model', state: 'not-loaded' });

    const { chatTurnNeedsModelLoad } = await import('../../src/api/ensure-chat-model-loaded.ts');

    assert.equal(
      chatTurnNeedsModelLoad(provider, 'chat-model'),
      true,
      'unloaded chat model must not inherit loaded state from another model on the same provider',
    );
    assert.equal(chatTurnNeedsModelLoad(provider, 'top-bar-model'), false);
  });

  test('ensureChatModelLoadedForTurn loads library id even when modelCache says loaded', async () => {
    setStorageModeForTests('server');
    modelCache.clear();
    loadLibraryCalls.length = 0;
    fetchModelsCallCount = 0;

    // Stale cache after eject — ensure must still call the library load path.
    const selectKey = encodeModelSelectKey(LIBRARY_PROVIDER_ID, LIBRARY_MODEL_ID);
    modelCache.set(selectKey, { id: LIBRARY_MODEL_ID, type: 'llm', state: 'loaded' });

    const { ensureChatModelLoadedForTurn } = await import(
      '../../src/api/ensure-chat-model-loaded.ts'
    );

    await ensureChatModelLoadedForTurn(LIBRARY_PROVIDER_ID, LIBRARY_MODEL_ID);

    assert.deepEqual(loadLibraryCalls, [LIBRARY_MODEL_ID]);
    assert.equal(fetchModelsCallCount, 1, 'library ensure refreshes catalog after load');
  });
});
