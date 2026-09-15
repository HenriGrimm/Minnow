/**
 * Voice config normalization tests (Phase 1 schema).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { defaultVoiceConfig, normalizeVoiceConfig } from '../../server/config/validators.js';

describe('voice config schema', () => {
  test('defaults to built-in dictation and system speech without a runtime', () => {
    const cpu = defaultVoiceConfig(false);
    assert.equal(cpu.stt.backend, 'builtin');
    assert.equal(cpu.stt.model, 'Xenova/whisper-tiny');
    assert.equal(cpu.tts.backend, 'browser');
    assert.equal(cpu.tts.providerId, 'browser');
    assert.equal(cpu.stt.local.modelId, 'openai/whisper-base');
    assert.equal(cpu.tts.local.modelId, 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice');
    assert.equal(cpu.tts.local.dtype, 'float32');

    const gpu = defaultVoiceConfig(true);
    assert.equal(gpu.stt.local.modelId, 'openai/whisper-small');
    assert.equal(gpu.tts.local.dtype, 'bfloat16');
  });

  test('migrates legacy flat provider fields', () => {
    const voice = normalizeVoiceConfig({
      stt: { providerId: 'openai', model: 'whisper-1', language: 'en' },
      tts: { providerId: 'openai', model: 'tts-1', voice: 'nova', speed: 1.2, format: 'mp3' },
    });
    assert.equal(voice.stt.backend, 'provider');
    assert.equal(voice.stt.provider.providerId, 'openai');
    assert.equal(voice.tts.provider.voice, 'nova');
    assert.equal(voice.tts.speed, 1.2);
  });

  test('defaultVoiceConfig includes TTS streaming tuning defaults', () => {
    const voice = defaultVoiceConfig(true);
    assert.deepEqual(voice.tts.local.streaming, {
      emitEveryFrames: 8,
      decodeWindowFrames: 80,
      firstChunkEmitEvery: 5,
      firstChunkDecodeWindow: 48,
      overlapSamples: 512,
      repetitionPenalty: 1.05,
    });
  });

  test('clamps TTS local streaming numeric fields', () => {
    const voice = normalizeVoiceConfig({
      tts: {
        local: {
          streaming: {
            emitEveryFrames: 99,
            decodeWindowFrames: 4,
            overlapSamples: 99999,
            repetitionPenalty: 5,
          },
        },
      },
    });
    assert.equal(voice.tts.local.streaming.emitEveryFrames, 32);
    assert.equal(voice.tts.local.streaming.decodeWindowFrames, 16);
    assert.equal(voice.tts.local.streaming.overlapSamples, 4096);
    assert.equal(voice.tts.local.streaming.repetitionPenalty, 2);
  });

  test('rejects instruct on 0.6B CustomVoice', () => {
    const voice = normalizeVoiceConfig({
      tts: {
        local: {
          modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
          customVoice: { instruct: 'Speak sadly' },
        },
      },
    });
    assert.equal(voice.tts.local.customVoice.instruct, '');
  });

  test('clamps STT local numeric thresholds', () => {
    const voice = normalizeVoiceConfig({
      stt: {
        local: {
          chunkLengthSeconds: 99,
          maxNewTokens: 900,
          numBeams: 9,
          compressionRatioThreshold: 5,
        },
      },
    });
    assert.equal(voice.stt.local.chunkLengthSeconds, 30);
    assert.equal(voice.stt.local.maxNewTokens, 448);
    assert.equal(voice.stt.local.numBeams, 5);
    assert.equal(voice.stt.local.compressionRatioThreshold, 2);
  });

  test('normalizes audio device block', () => {
    const voice = normalizeVoiceConfig({
      audio: {
        inputDeviceId: ' mic-1 ',
        echoCancellation: false,
      },
    });
    assert.equal(voice.audio.inputDeviceId, 'mic-1');
    assert.equal(voice.audio.echoCancellation, false);
    assert.equal(voice.audio.noiseSuppression, true);
  });

  test('keeps provider backend when local models are not installed', () => {
    const voice = normalizeVoiceConfig(
      {
        stt: { backend: 'local', provider: { providerId: 'openai', model: 'whisper-1' } },
        tts: { backend: 'local', provider: { providerId: 'openai', model: 'tts-1' } },
      },
      {
        stt: { backend: 'local', provider: { providerId: 'openai', model: 'whisper-1' } },
        tts: { backend: 'local', provider: { providerId: 'openai', model: 'tts-1' } },
      },
      { installedManifest: { stt: [], tts: [] } },
    );
    assert.equal(voice.stt.backend, 'provider');
    assert.equal(voice.tts.backend, 'provider');
    assert.equal(voice.stt.provider.providerId, 'openai');
  });
});
