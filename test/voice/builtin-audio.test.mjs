import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeVoiceWav } from '../../server/voice/builtin-audio.js';
import { defaultVoiceConfig, normalizeVoiceConfig } from '../../server/config/validators.js';
import { buildSttStatus } from '../../server/stt/middleware.js';
import { getVoiceWorkerScriptPath } from '../../server/voice/paths.js';
import path from 'node:path';
import fs from 'node:fs';

test('packaged Python worker is outside ASAR and its files are unpacked by the builder', () => {
  const packagedModule = path.resolve('resources', 'app.asar', 'server', 'voice', 'paths.js');
  assert.equal(getVoiceWorkerScriptPath(packagedModule),
    path.resolve('resources', 'app.asar.unpacked', 'server', 'voice', 'python', 'worker.py'));
  assert.ok(fs.existsSync(getVoiceWorkerScriptPath()));
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.asarUnpack.includes('server/voice/python/**'));
});

function wav(samples = [-32768, 0, 32767]) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2));
  return b;
}

test('decodes signed PCM and rejects unsupported or truncated audio before inference', () => {
  assert.deepEqual([...decodeVoiceWav(wav())], [-1, 0, 32767 / 32768]);
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  assert.throws(() => decodeVoiceWav(stereo), /Unsupported/);
  assert.throws(() => decodeVoiceWav(wav().subarray(0, 45)), /truncated/);
  assert.throws(() => decodeVoiceWav(Buffer.from('bad')), /Unsupported/);
  assert.throws(() => decodeVoiceWav(wav(), 0.0001), /duration/);
});

test('WAV decoder handles metadata chunks and padding', () => {
  const source = wav();
  const chunk = Buffer.alloc(10); chunk.write('JUNK'); chunk.writeUInt32LE(1, 4);
  const b = Buffer.concat([source.subarray(0, 36), chunk, source.subarray(36)]);
  b.writeUInt32LE(b.length - 8, 4);
  assert.deepEqual(decodeVoiceWav(b), decodeVoiceWav(source));
});

test('built-in status is usable without installing or starting Python; disabled remains disabled', async () => {
  const config = defaultVoiceConfig();
  const status = await buildSttStatus(config);
  assert.equal(status.backend, 'builtin');
  assert.equal(status.healthy, true);
  assert.equal(status.modelLoaded, false);
  config.stt.enabled = false;
  assert.equal((await buildSttStatus(config)).healthy, false);
});

test('old uninstalled default models use built-in voice, installed and custom models retain local', () => {
  const old = defaultVoiceConfig();
  old.stt.backend = old.tts.backend = 'local';
  const migrated = normalizeVoiceConfig(old, old, { installedManifest: { stt: [], tts: [] } });
  assert.equal(migrated.stt.backend, 'builtin');
  assert.equal(migrated.tts.backend, 'browser');
  const retained = normalizeVoiceConfig(old, old, {
    installedManifest: { stt: [{ modelId: old.stt.local.modelId }], tts: [{ modelId: old.tts.local.modelId }] },
  });
  assert.equal(retained.stt.backend, 'local');
  assert.equal(retained.tts.backend, 'local');
  old.stt.local.modelId = 'openai/whisper-large-v3';
  assert.equal(normalizeVoiceConfig(old, old, { installedManifest: { stt: [] } }).stt.backend, 'local');
});

test('partial settings changes preserve backend and enabled preferences', () => {
  const existing = defaultVoiceConfig();
  existing.stt.enabled = false;
  existing.tts.backend = 'local';
  const result = normalizeVoiceConfig({ stt: { enabled: true }, tts: { streaming: false } }, existing);
  assert.equal(result.stt.backend, 'builtin');
  assert.equal(result.stt.enabled, true);
  assert.equal(result.tts.backend, 'local');
});
