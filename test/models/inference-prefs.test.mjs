/**
 * Per-library-model inference prefs in config.json.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  getInferencePrefs,
  normalizeInferenceBlock,
  setLibraryInferenceSampler,
} from '../../server/models/inference-prefs.js';

describe('models inference prefs', () => {
  /** @type {string} */
  let homeDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-inference-prefs-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await fs.mkdir(path.join(homeDir, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, 'config.json'),
      `${JSON.stringify({ models: {} })}\n`,
    );
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('normalizeInferenceBlock drops invalid sampler fields', () => {
    const out = normalizeInferenceBlock({
      byLibraryId: {
        'gguf:qwen:file.gguf': { temperature: 99, topP: 0.5 },
      },
      chatModelAliases: { 'my-label': 'gguf:qwen:file.gguf' },
    });
    assert.equal(out.byLibraryId['gguf:qwen:file.gguf'].temperature, 2);
    assert.equal(out.byLibraryId['gguf:qwen:file.gguf'].topP, 0.5);
    assert.equal(out.chatModelAliases['my-label'], 'gguf:qwen:file.gguf');
  });

  test('setLibraryInferenceSampler persists and clears', async () => {
    const libraryId = 'gguf:repo:weights.gguf';
    let prefs = await setLibraryInferenceSampler(
      libraryId,
      { temperature: 0.6, topP: 0.9 },
      ['served-label', 'Qwen3-8B'],
    );
    assert.equal(prefs.byLibraryId[libraryId].temperature, 0.6);
    assert.equal(prefs.chatModelAliases['served-label'], libraryId);

    prefs = await getInferencePrefs();
    assert.equal(prefs.chatModelAliases['Qwen3-8B'], libraryId);

    prefs = await setLibraryInferenceSampler(libraryId, null);
    assert.equal(prefs.byLibraryId[libraryId], undefined);
    assert.equal(prefs.chatModelAliases['served-label'], undefined);
  });

  test('neutral sampler values survive storage and a subsequent custom override', async () => {
    const libraryId = 'gguf:Qwen/Qwen3.6-27B:weights.gguf';
    const preset = {
      temperature: 0.6, topP: 0.95, topK: 20,
      minP: 0, presencePenalty: 0, repetitionPenalty: 1,
    };
    await setLibraryInferenceSampler(libraryId, preset, ['Qwen3.6-27B']);
    let prefs = await getInferencePrefs();
    assert.deepEqual(prefs.byLibraryId[libraryId], preset);

    await setLibraryInferenceSampler(libraryId, { ...preset, temperature: 0.85 });
    prefs = await getInferencePrefs();
    assert.deepEqual(prefs.byLibraryId[libraryId], { ...preset, temperature: 0.85 });
  });
});
