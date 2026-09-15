/**
 * Web Audio scheduler for continuous Int16 PCM with adaptive buffering.
 */

const DEFAULT_OVERLAP_MS = 10;
const MIN_SCHEDULE_AHEAD_SEC = 0.05;

/** Convert little-endian Int16 mono PCM to normalized float32 [-1, 1]. */
export function int16LeToFloat32(pcm: ArrayBuffer): Float32Array {
  const view = new DataView(pcm);
  const count = Math.floor(pcm.byteLength / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const sample = view.getInt16(i * 2, true);
    out[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

/** Hann window of the given length (inclusive endpoints). */
export function hannWindow(length: number): Float32Array {
  const win = new Float32Array(length);
  if (length <= 0) return win;
  if (length === 1) {
    win[0] = 1;
    return win;
  }
  for (let i = 0; i < length; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
  }
  return win;
}

/**
 * Crossfade the tail of `previous` with the head of `next` over `overlap` samples.
 * Returns one contiguous buffer ready to schedule.
 */
export function crossfadePcmChunks(
  previous: Float32Array,
  next: Float32Array,
  overlap: number,
): Float32Array {
  const o = Math.min(overlap, previous.length, next.length);
  if (o <= 0) {
    const merged = new Float32Array(previous.length + next.length);
    merged.set(previous, 0);
    merged.set(next, previous.length);
    return merged;
  }

  const hann = hannWindow(o);
  const merged = new Float32Array(previous.length + next.length - o);
  const preBody = previous.length - o;
  merged.set(previous.subarray(0, preBody), 0);

  for (let i = 0; i < o; i++) {
    const fadeOut = 1 - (hann[i] ?? 0);
    const fadeIn = hann[i] ?? 0;
    merged[preBody + i] =
      (previous[preBody + i] ?? 0) * fadeOut + (next[i] ?? 0) * fadeIn;
  }

  merged.set(next.subarray(o), preBody + o);
  return merged;
}

/** Linear resample float PCM when context rate differs from stream rate. */
export function resampleFloat32(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const outLen = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = (i * fromRate) / toRate;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = samples[idx] ?? 0;
    const b = samples[Math.min(idx + 1, samples.length - 1)] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Overlap sample count for a sample rate and millisecond window. */
export function overlapSamplesForRate(sampleRate: number, overlapMs = DEFAULT_OVERLAP_MS): number {
  return Math.max(1, Math.round((sampleRate * overlapMs) / 1000));
}

export interface AudioPlaybackQueueOptions {
  outputDeviceId?: string;
  /** Audio reserve before starting playback on a stream that can keep up. */
  bufferSeconds?: number;
  onPlaybackStart?: () => void;
  onBuffering?: () => void;
}

/** Preserve every sample; Qwen already blends its decoder boundaries. */
export class AudioPlaybackQueue {
  private ctx: AudioContext | null = null;
  private sampleRate = 24_000;
  private nextStartTime = 0;
  private scheduledSources = new Set<AudioBufferSourceNode>();
  private stopped = false;
  private finished = false;
  private processing: Promise<void> = Promise.resolve();
  private drainResolvers: Array<() => void> = [];
  private buffered: Float32Array[] = [];
  private bufferedSeconds = 0;
  private playing = false;
  private firstArrival: number | null = null;
  private lastArrival = 0;
  private receivedAfterFirst = 0;
  private longestGap = 0;
  private arrivals = 0;
  private options: AudioPlaybackQueueOptions;

  constructor(options: AudioPlaybackQueueOptions = {}) {
    this.options = options;
  }

  setSampleRate(sampleRate: number): void {
    if (Number.isFinite(sampleRate) && sampleRate > 0 && this.arrivals === 0) {
      this.sampleRate = sampleRate;
    }
  }

  /** Serialize audio setup, enqueues and drain so final chunks cannot be lost. */
  enqueue(pcm: ArrayBuffer): Promise<void> {
    if (this.stopped || this.finished || pcm.byteLength < 2) return Promise.resolve();
    const arrival = performance.now() / 1000;
    this.processing = this.processing.then(async () => {
      if (this.stopped) return;
      const ctx = await this.ensureContext();
      if (this.stopped) return;
      const samples = int16LeToFloat32(pcm);
      const duration = samples.length / this.sampleRate;
      if (this.firstArrival === null) this.firstArrival = arrival;
      else {
        this.receivedAfterFirst += duration;
        this.longestGap = Math.max(this.longestGap, arrival - this.lastArrival);
      }
      this.lastArrival = arrival;
      this.arrivals++;
      if (this.playing && this.nextStartTime <= ctx.currentTime) {
        this.playing = false;
        this.options.onBuffering?.();
      }
      this.buffered.push(samples);
      this.bufferedSeconds += duration;
      this.flushBuffered(ctx, false);
    });
    return this.processing;
  }

  stop(): void {
    this.stopped = true;
    this.buffered = [];
    this.bufferedSeconds = 0;
    for (const source of this.scheduledSources) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
    }
    this.scheduledSources.clear();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.resolveDrainWaiters();
  }

  /** Slow generators finish buffering before playback, instead of stuttering. */
  async drain(): Promise<void> {
    this.finished = true;
    await this.processing;
    if (this.stopped) return;
    if (this.ctx) this.flushBuffered(this.ctx, true);
    if (!this.scheduledSources.size) return;
    await new Promise<void>((resolve) => { this.drainResolvers.push(resolve); });
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      try { this.ctx = new AudioContext({ sampleRate: this.sampleRate }); }
      catch { this.ctx = new AudioContext(); }
      const ctx = this.ctx;
      const sinkable = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (this.options.outputDeviceId && typeof sinkable.setSinkId === 'function') {
        try { await sinkable.setSinkId(this.options.outputDeviceId); } catch {}
      }
      if (!this.stopped && ctx.state === 'suspended') await ctx.resume();
      return ctx;
    }
    return this.ctx;
  }

  private flushBuffered(ctx: AudioContext, force: boolean): void {
    if (this.stopped || !this.buffered.length) return;
    if (!this.playing && !force) {
      const elapsed = this.lastArrival - (this.firstArrival ?? this.lastArrival);
      const rate = elapsed > 0 ? this.receivedAfterFirst / elapsed : Infinity;
      const reserve = Math.max(this.options.bufferSeconds ?? 0.8, this.longestGap * 1.5);
      // One chunk cannot tell us whether generation is faster than playback.
      if (this.arrivals < 2 || this.bufferedSeconds < reserve || rate < 1.2) return;
    }
    if (!this.playing) {
      this.nextStartTime = Math.max(this.nextStartTime, ctx.currentTime + MIN_SCHEDULE_AHEAD_SEC);
      this.playing = true;
      this.options.onPlaybackStart?.();
    }
    for (const samples of this.buffered) this.scheduleBuffer(ctx, samples);
    this.buffered = [];
    this.bufferedSeconds = 0;
  }

  private scheduleBuffer(ctx: AudioContext, samples: Float32Array): void {
    // Let Web Audio resample natively; rounding each chunk changes stream length.
    const buffer = ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      source.disconnect();
      this.scheduledSources.delete(source);
      if (this.finished && !this.scheduledSources.size && !this.buffered.length) {
        this.resolveDrainWaiters();
      }
    };
    this.scheduledSources.add(source);
    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;
  }

  private resolveDrainWaiters(): void {
    const waiters = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of waiters) resolve();
  }
}
