/**
 * Voice installed manifest rebuild from on-disk model snapshots.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  listInstalledVoiceModels,
  listVoiceDownloads,
  resetVoiceDownloadsForTests,
} from '../../server/voice/download.js';
import { getVoiceDownloadsIndexPath, getVoiceInstalledPath, getVoiceModelsRoot } from '../../server/voice/paths.js';

describe('voice installed manifest rebuild', () => {
  let homeDir = '';

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-voice-manifest-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await resetVoiceDownloadsForTests();
  });

  after(async () => {
    await resetVoiceDownloadsForTests();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('rebuilds installed.json from HF snapshot folders when manifest is missing', async () => {
    const modelsRoot = getVoiceModelsRoot();
    const sttDir = path.join(modelsRoot, 'openai--whisper-small');
    const ttsDir = path.join(modelsRoot, 'Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice');
    await fs.mkdir(sttDir, { recursive: true });
    await fs.mkdir(ttsDir, { recursive: true });
    await fs.writeFile(path.join(sttDir, 'config.json'), '{"model_type":"whisper"}\n', 'utf8');
    await fs.writeFile(path.join(ttsDir, 'config.json'), '{"model_type":"qwen3_tts"}\n', 'utf8');

    await fs.writeFile(path.join(sttDir, 'model.bin'), 'fixture weights');
    await fs.writeFile(path.join(ttsDir, 'model.safetensors'), 'fixture weights');
    const incomplete = path.join(modelsRoot, 'openai--whisper-base');
    await fs.mkdir(incomplete);
    await fs.writeFile(path.join(incomplete, 'config.json'), '{}');
    const manifest = await listInstalledVoiceModels();
    assert.ok(!manifest.stt.some(row => row.modelId === 'openai/whisper-base'));

    assert.ok(
      manifest.stt.some((row) => row.modelId === 'openai/whisper-small'),
      'expected STT model rebuilt from disk',
    );
    assert.ok(
      manifest.tts.some(
        (row) =>
          row.modelId === 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice' && row.mode === 'custom_voice',
      ),
      'expected TTS model rebuilt from disk with catalog mode',
    );

    const raw = await fs.readFile(getVoiceInstalledPath(), 'utf8');
    const persisted = JSON.parse(raw);
    assert.equal(persisted.stt.length, 1);
    assert.equal(persisted.tts.length, 1);
  });
  test('recovers interrupted jobs, retaining legacy bytes outside discovery', async () => {
    await resetVoiceDownloadsForTests();
    const job = { id: 'd4199352-ea4c-4d39-9919-13c753ddc39a', modelId: 'openai/whisper-base', kind: 'stt', status: 'running' };
    const modelRoot = getVoiceModelsRoot();
    await fs.writeFile(getVoiceDownloadsIndexPath(), JSON.stringify({ jobs: [job] }));
    const manifest = await listInstalledVoiceModels();
    assert.ok(!manifest.stt.some(row => row.modelId === job.modelId));
    assert.equal((await listVoiceDownloads())[0].status, 'failed');
    const archived = path.join(path.dirname(modelRoot), '.voice-downloads', 'interrupted-' + job.id, 'openai--whisper-base');
    assert.equal(await fs.readFile(path.join(archived, 'config.json'), 'utf8'), '{}');
    await assert.rejects(fs.stat(path.join(modelRoot, 'openai--whisper-base')), { code: 'ENOENT' });
  });
});
