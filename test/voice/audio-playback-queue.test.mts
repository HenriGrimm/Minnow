/**
 * Audio playback queue conversion and continuous scheduling regressions.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AudioPlaybackQueue,
  crossfadePcmChunks,
  hannWindow,
  int16LeToFloat32,
  overlapSamplesForRate,
} from '../../src/voice/audio-playback-queue.ts';

describe('audio-playback-queue', () => {
  test('int16LeToFloat32 decodes little-endian mono samples', () => {
    const bytes = new ArrayBuffer(4);
    const view = new DataView(bytes);
    view.setInt16(0, 16384, true);
    view.setInt16(2, -16384, true);
    const floats = int16LeToFloat32(bytes);
    assert.equal(floats.length, 2);
    assert.ok(Math.abs(floats[0]! - 0.5) < 0.001);
    assert.ok(Math.abs(floats[1]! + 0.5) < 0.001);
  });

  test('hannWindow endpoints are zero-ish and center is one', () => {
    const win = hannWindow(5);
    assert.equal(win.length, 5);
    assert.ok(win[0]! < 0.01);
    assert.ok(win[4]! < 0.01);
    assert.ok(Math.abs(win[2]! - 1) < 0.01);
  });

  test('crossfadePcmChunks merges buffers with overlap length preserved', () => {
    const prev = new Float32Array([0, 0, 1, 0]);
    const next = new Float32Array([0, 1, 1, 0]);
    const merged = crossfadePcmChunks(prev, next, 2);
    assert.equal(merged.length, prev.length + next.length - 2);
    assert.equal(merged[0], 0);
    assert.equal(merged[1], 0);
    assert.equal(merged[4], 1);
    assert.equal(merged[5], 0);
  });

  test('overlapSamplesForRate scales with sample rate', () => {
    assert.equal(overlapSamplesForRate(24_000, 10), 240);
    assert.equal(overlapSamplesForRate(16_000, 10), 160);
  });
});

/** Deterministic Web Audio clock; no speakers or real-time sleeps required. */
function audioHarness() {
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let time = 0;
  const sources: Array<{ buffer: any; startAt: number; onended: (() => void) | null; disconnected: boolean }> = [];
  let resume: (() => Promise<void>) | undefined;
  class Context {
    sampleRate = 48_000;
    state = 'suspended';
    destination = {};
    get currentTime() { return time; }
    async resume() { if (resume) await resume(); this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createBuffer(_channels: number, length: number, rate: number) {
      const samples = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => samples };
    }
    createBufferSource() {
      const source = {
        buffer: null as any, startAt: -1, onended: null as (() => void) | null,
        disconnected: false,
        connect() {}, disconnect() { source.disconnected = true; }, stop() {},
        start(at: number) { source.startAt = at; },
      };
      sources.push(source);
      return source;
    }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => time * 1000 } });
  return {
    sources,
    at(value: number) { time = value; },
    deferResume(fn: () => Promise<void>) { resume = fn; },
    end() { for (const source of sources) source.onended?.(); },
    restore() {
      if (originalAudio) Object.defineProperty(globalThis, 'AudioContext', originalAudio);
      else Reflect.deleteProperty(globalThis, 'AudioContext');
      if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance);
    },
  };
}

function pcm(seconds: number): ArrayBuffer {
  return new Int16Array(Math.round(seconds * 24_000)).fill(1234).buffer;
}

describe('stream playback scheduling', () => {
  test('slow Qwen delivery buffers to completion and preserves every PCM sample', async () => {
    const audio = audioHarness();
    const queue = new AudioPlaybackQueue();
    try {
      for (let i = 0; i < 6; i++) {
        audio.at(1.52 + i * 0.58);
        await queue.enqueue(pcm(0.37866666666666665));
      }
      assert.equal(audio.sources.length, 0, 'do not play speech faster than it arrives');
      const finished = queue.drain();
      await Promise.resolve();
      assert.equal(audio.sources.length, 6);
      const samples = audio.sources.reduce((n, source) => n + source.buffer.getChannelData(0).length, 0);
      assert.equal(samples, 6 * 9088, 'no crossfade removes samples at chunk boundaries');
      for (let i = 1; i < audio.sources.length; i++) {
        const prev = audio.sources[i - 1]!;
        assert.equal(audio.sources[i]!.startAt, prev.startAt + prev.buffer.duration);
      }
      audio.end();
      await finished;
      assert.ok(audio.sources.every((source) => source.disconnected));
    } finally { queue.stop(); audio.restore(); }
  });

  test('fast streams start early and add no silence at boundaries with short scheduling lead', async () => {
    const audio = audioHarness();
    let starts = 0;
    const queue = new AudioPlaybackQueue({ onPlaybackStart: () => starts++ });
    try {
      await queue.enqueue(pcm(0.5));
      audio.at(0.1);
      await queue.enqueue(pcm(0.5));
      assert.equal(starts, 1);
      assert.equal(audio.sources.length, 2);
      audio.at(1.13);
      await queue.enqueue(pcm(0.5));
      assert.equal(audio.sources[2]!.startAt, audio.sources[1]!.startAt + 0.5);
      const finished = queue.drain();
      await Promise.resolve();
      audio.end();
      await finished;
    } finally { queue.stop(); audio.restore(); }
  });

  test('a stalled stream re-buffers instead of repeatedly playing isolated chunks', async () => {
    const audio = audioHarness();
    let buffering = 0;
    const queue = new AudioPlaybackQueue({ onBuffering: () => buffering++ });
    try {
      await queue.enqueue(pcm(0.5));
      audio.at(0.1);
      await queue.enqueue(pcm(0.5));
      audio.end();
      audio.at(2);
      await queue.enqueue(pcm(0.5));
      audio.at(3);
      await queue.enqueue(pcm(0.5));
      assert.equal(buffering, 1);
      assert.equal(audio.sources.length, 2);
      const finished = queue.drain();
      await Promise.resolve();
      assert.equal(audio.sources.length, 4);
      assert.equal(audio.sources[3]!.startAt, audio.sources[2]!.startAt + 0.5);
      audio.end();
      await finished;
    } finally { queue.stop(); audio.restore(); }
  });

  test('drain waits for queued audio initialization, including a short final chunk', async () => {
    const audio = audioHarness();
    let release!: () => void;
    audio.deferResume(() => new Promise<void>((resolve) => { release = resolve; }));
    const queue = new AudioPlaybackQueue();
    try {
      const first = queue.enqueue(pcm(0.01));
      const second = queue.enqueue(pcm(0.005));
      const finished = queue.drain();
      await Promise.resolve();
      assert.equal(audio.sources.length, 0);
      release();
      await Promise.all([first, second]);
      assert.equal(audio.sources.length, 2);
      assert.equal(audio.sources[0]!.buffer.duration + audio.sources[1]!.buffer.duration, 0.015);
      audio.end();
      await finished;
    } finally { queue.stop(); audio.restore(); }
  });

  test('stop during initialization never schedules late audio', async () => {
    const audio = audioHarness();
    let release!: () => void;
    audio.deferResume(() => new Promise<void>((resolve) => { release = resolve; }));
    const queue = new AudioPlaybackQueue();
    try {
      const enqueue = queue.enqueue(pcm(1));
      await Promise.resolve();
      queue.stop();
      release();
      await enqueue;
      await queue.drain();
      assert.equal(audio.sources.length, 0);
    } finally { audio.restore(); }
  });
});
