/**
 * Voice I/O settings persisted in ~/.minnow/config.json (`voice` block).
 */

import { detectConfigServer } from './storage-mode';

/** Settings → Audio device and capture constraints. */
export interface VoiceAudioConfig {
  inputDeviceId: string;
  outputDeviceId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/** Shared upload / duration caps (all backends). */
export interface VoiceLimitsConfig {
  maxAudioBytes: number;
  maxDurationSeconds: number;
  /** Seconds of silence after speech before auto-submitting mic dictation (0 = manual stop only). */
  silenceTimeoutSeconds: number;
}

/** Local Whisper runtime + decoding (HF Transformers pipeline). */
export interface VoiceSttLocalConfig {
  modelId: string;
  language: string;
  task: 'transcribe' | 'translate';
  longFormAlgorithm: 'sequential' | 'chunked';
  chunkLengthSeconds: number;
  batchSize: number;
  returnTimestamps: boolean;
  timestampGranularity: 'segment' | 'word';
  maxNewTokens: number;
  numBeams: number;
  conditionOnPrevTokens: boolean;
  compressionRatioThreshold: number;
  temperatureFallback: boolean;
  temperature: number;
  logprobThreshold: number;
  noSpeechThreshold: number;
  device: 'auto' | 'cpu' | 'cuda';
  computeType: 'auto' | 'float16' | 'bfloat16' | 'float32';
  attnImplementation: 'auto' | 'sdpa' | 'flash_attention_2';
  useSafetensors: boolean;
  lowCpuMemUsage: boolean;
  torchCompile: boolean;
  /** Live PCM streaming dictation (local backend only). */
  streamingEnabled: boolean;
}

/** External OpenAI-compatible STT API. */
export interface VoiceSttProviderConfig {
  providerId: string;
  model: string;
  language: string;
  prompt: string;
  responseFormat: 'json' | 'text' | 'verbose_json' | 'srt' | 'vtt';
  temperature: number;
}

export interface VoiceSttConfig {
  enabled: boolean;
  backend: 'builtin' | 'local' | 'provider';
  local: VoiceSttLocalConfig;
  provider: VoiceSttProviderConfig;
  /** @deprecated Legacy flat fields — synced from active backend for middleware compat. */
  providerId: string;
  /** @deprecated */
  model: string;
  /** @deprecated */
  language: string;
}

/** Shared local Qwen runtime (all Qwen3-TTS model variants). */
export interface VoiceTtsLocalRuntimeConfig {
  modelId: string;
  deviceMap: 'auto' | 'cpu' | 'cuda:0';
  dtype: 'auto' | 'bfloat16' | 'float16' | 'float32';
  attnImplementation: 'auto' | 'flash_attention_2' | 'sdpa' | 'eager';
  tokenizerModelId: string;
}

export interface VoiceTtsCustomVoiceConfig {
  speaker: string;
  language: string;
  instruct: string;
}

export interface VoiceTtsVoiceDesignConfig {
  language: string;
  instruct: string;
}

export interface VoiceTtsVoiceCloneConfig {
  refAudioPath: string;
  refText: string;
  xVectorOnlyMode: boolean;
  language: string;
  savedPromptId: string;
}

export interface VoiceTtsGenerationConfig {
  maxNewTokens: number;
  topP: number;
  topK: number;
  temperature: number;
  repetitionPenalty: number;
}

/** PCM streaming tuning for local Qwen3-TTS worker (`tts.local.streaming`). */
export interface VoiceTtsLocalStreamingConfig {
  emitEveryFrames: number;
  decodeWindowFrames: number;
  firstChunkEmitEvery: number;
  firstChunkDecodeWindow: number;
  overlapSamples: number;
  repetitionPenalty: number;
}

/** External OpenAI-compatible TTS API. */
export interface VoiceTtsProviderConfig {
  providerId: string;
  model: string;
  voice: string;
  speed: number;
  format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
}

/** Browser speechSynthesis fallback. */
export interface VoiceTtsBrowserConfig {
  voiceUri: string;
  rate: number;
  pitch: number;
  volume: number;
}

export interface VoiceTtsLocalConfig extends VoiceTtsLocalRuntimeConfig {
  mode: 'custom_voice' | 'voice_design' | 'voice_clone';
  customVoice: VoiceTtsCustomVoiceConfig;
  voiceDesign: VoiceTtsVoiceDesignConfig;
  voiceClone: VoiceTtsVoiceCloneConfig;
  generation: VoiceTtsGenerationConfig;
  streaming: VoiceTtsLocalStreamingConfig;
}

export interface VoiceTtsConfig {
  enabled: boolean;
  backend: 'local' | 'provider' | 'browser';
  streaming: boolean;
  local: VoiceTtsLocalConfig;
  provider: VoiceTtsProviderConfig;
  browser: VoiceTtsBrowserConfig;
  /** @deprecated Legacy flat fields — synced from active backend for middleware compat. */
  providerId: string;
  /** @deprecated */
  model: string;
  /** @deprecated */
  voice: string;
  /** @deprecated */
  speed: number;
  /** @deprecated */
  format: string;
}

export interface VoiceConfig {
  audio: VoiceAudioConfig;
  stt: VoiceSttConfig;
  tts: VoiceTtsConfig;
  limits: VoiceLimitsConfig;
}

const QWEN_CUSTOM_VOICE_06B = 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice';

// ── Defaults ─────────────────────────────────────────────────────────────────

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function defaultSttLocal(cudaAvailable = false): VoiceSttLocalConfig {
  return {
    modelId: cudaAvailable ? 'openai/whisper-small' : 'openai/whisper-base',
    language: '',
    task: 'transcribe',
    longFormAlgorithm: 'chunked',
    chunkLengthSeconds: 30,
    batchSize: 1,
    returnTimestamps: false,
    timestampGranularity: 'segment',
    maxNewTokens: 448,
    numBeams: 1,
    conditionOnPrevTokens: false,
    compressionRatioThreshold: 1.35,
    temperatureFallback: true,
    temperature: 0,
    logprobThreshold: -1,
    noSpeechThreshold: 0.6,
    device: 'auto',
    computeType: 'auto',
    attnImplementation: 'auto',
    useSafetensors: true,
    lowCpuMemUsage: true,
    torchCompile: false,
    streamingEnabled: true,
  };
}

function defaultSttProvider(): VoiceSttProviderConfig {
  return {
    providerId: '',
    model: 'whisper-1',
    language: 'en',
    prompt: '',
    responseFormat: 'json',
    temperature: 0,
  };
}

function defaultTtsLocalStreaming(): VoiceTtsLocalStreamingConfig {
  return {
    emitEveryFrames: 8,
    decodeWindowFrames: 80,
    firstChunkEmitEvery: 5,
    firstChunkDecodeWindow: 48,
    overlapSamples: 512,
    repetitionPenalty: 1.05,
  };
}

function defaultTtsLocal(cudaAvailable = false): VoiceTtsLocalConfig {
  return {
    modelId: QWEN_CUSTOM_VOICE_06B,
    deviceMap: 'auto',
    dtype: cudaAvailable ? 'bfloat16' : 'float32',
    attnImplementation: 'auto',
    tokenizerModelId: 'Qwen/Qwen3-TTS-Tokenizer-12Hz',
    mode: 'custom_voice',
    customVoice: {
      speaker: 'Ryan',
      language: 'Auto',
      instruct: '',
    },
    voiceDesign: {
      language: 'Auto',
      instruct: '',
    },
    voiceClone: {
      refAudioPath: '',
      refText: '',
      xVectorOnlyMode: false,
      language: 'Auto',
      savedPromptId: '',
    },
    generation: {
      maxNewTokens: 2048,
      topP: 1,
      topK: 50,
      temperature: 0.9,
      repetitionPenalty: 1,
    },
    streaming: defaultTtsLocalStreaming(),
  };
}

function defaultTtsProvider(): VoiceTtsProviderConfig {
  return {
    providerId: '',
    model: 'tts-1',
    voice: 'alloy',
    speed: 1,
    format: 'mp3',
  };
}

function defaultTtsBrowser(): VoiceTtsBrowserConfig {
  return {
    voiceUri: '',
    rate: 1,
    pitch: 1,
    volume: 1,
  };
}

function defaultAudio(): VoiceAudioConfig {
  return {
    inputDeviceId: '',
    outputDeviceId: '',
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

/** Built-in dictation and system speech need no Python runtime or API key. */
export function createDefaultVoiceConfig(cudaAvailable = false): VoiceConfig {
  const sttLocal = defaultSttLocal(cudaAvailable);
  const sttProvider = defaultSttProvider();
  const ttsLocal = defaultTtsLocal(cudaAvailable);
  const ttsProvider = defaultTtsProvider();
  const ttsBrowser = defaultTtsBrowser();
  return {
    audio: defaultAudio(),
    stt: {
      enabled: true,
      backend: 'builtin',
      local: sttLocal,
      provider: sttProvider,
      providerId: '',
      model: 'Xenova/whisper-tiny',
      language: sttLocal.language,
    },
    tts: {
      enabled: true,
      backend: 'browser',
      streaming: true,
      local: ttsLocal,
      provider: ttsProvider,
      browser: ttsBrowser,
      providerId: 'browser',
      model: '',
      voice: '',
      speed: 1,
      format: 'wav',
    },
    limits: {
      maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 300,
      silenceTimeoutSeconds: 2.5,
    },
  };
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = createDefaultVoiceConfig(false);

const VOICE_META_STORAGE_KEY = 'minnow.voiceMeta';

let cachedVoice: VoiceConfig | null = null;

function isQwen06bCustomVoice(modelId: string): boolean {
  return modelId.includes('0.6B-CustomVoice');
}

// ── Parse ────────────────────────────────────────────────────────────────────

function parseSttLocal(raw: Record<string, unknown>, base: VoiceSttLocalConfig): VoiceSttLocalConfig {
  const out = { ...base };
  if (typeof raw.modelId === 'string' && raw.modelId.trim()) {
    out.modelId = raw.modelId.trim();
  }
  if (typeof raw.language === 'string') out.language = raw.language.trim();
  if (raw.task === 'transcribe' || raw.task === 'translate') out.task = raw.task;
  if (raw.longFormAlgorithm === 'sequential' || raw.longFormAlgorithm === 'chunked') {
    out.longFormAlgorithm = raw.longFormAlgorithm;
  }
  out.chunkLengthSeconds = clampNum(raw.chunkLengthSeconds, 10, 30, out.chunkLengthSeconds);
  out.batchSize = clampNum(raw.batchSize, 1, 16, out.batchSize);
  if (typeof raw.returnTimestamps === 'boolean') out.returnTimestamps = raw.returnTimestamps;
  if (raw.timestampGranularity === 'segment' || raw.timestampGranularity === 'word') {
    out.timestampGranularity = raw.timestampGranularity;
  }
  out.maxNewTokens = clampNum(raw.maxNewTokens, 1, 448, out.maxNewTokens);
  out.numBeams = clampNum(raw.numBeams, 1, 5, out.numBeams);
  if (typeof raw.conditionOnPrevTokens === 'boolean') {
    out.conditionOnPrevTokens = raw.conditionOnPrevTokens;
  }
  out.compressionRatioThreshold = clampNum(
    raw.compressionRatioThreshold,
    0.5,
    2,
    out.compressionRatioThreshold,
  );
  if (typeof raw.temperatureFallback === 'boolean') {
    out.temperatureFallback = raw.temperatureFallback;
  }
  out.temperature = clampNum(raw.temperature, 0, 1, out.temperature);
  out.logprobThreshold = clampNum(raw.logprobThreshold, -2, 0, out.logprobThreshold);
  out.noSpeechThreshold = clampNum(raw.noSpeechThreshold, 0, 1, out.noSpeechThreshold);
  if (raw.device === 'auto' || raw.device === 'cpu' || raw.device === 'cuda') {
    out.device = raw.device;
  }
  if (
    raw.computeType === 'auto' ||
    raw.computeType === 'float16' ||
    raw.computeType === 'bfloat16' ||
    raw.computeType === 'float32'
  ) {
    out.computeType = raw.computeType;
  }
  if (
    raw.attnImplementation === 'auto' ||
    raw.attnImplementation === 'sdpa' ||
    raw.attnImplementation === 'flash_attention_2'
  ) {
    out.attnImplementation = raw.attnImplementation;
  }
  if (typeof raw.useSafetensors === 'boolean') out.useSafetensors = raw.useSafetensors;
  if (typeof raw.lowCpuMemUsage === 'boolean') out.lowCpuMemUsage = raw.lowCpuMemUsage;
  if (typeof raw.torchCompile === 'boolean') out.torchCompile = raw.torchCompile;
  if (typeof raw.streamingEnabled === 'boolean') out.streamingEnabled = raw.streamingEnabled;
  return out;
}

function parseSttProvider(raw: Record<string, unknown>, base: VoiceSttProviderConfig): VoiceSttProviderConfig {
  const out = { ...base };
  if (typeof raw.providerId === 'string') out.providerId = raw.providerId.trim();
  if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.trim();
  if (typeof raw.language === 'string') out.language = raw.language.trim();
  if (typeof raw.prompt === 'string') out.prompt = raw.prompt;
  const formats = new Set(['json', 'text', 'verbose_json', 'srt', 'vtt']);
  if (typeof raw.responseFormat === 'string' && formats.has(raw.responseFormat)) {
    out.responseFormat = raw.responseFormat as VoiceSttProviderConfig['responseFormat'];
  }
  out.temperature = clampNum(raw.temperature, 0, 1, out.temperature);
  return out;
}

function parseTtsLocal(raw: Record<string, unknown>, base: VoiceTtsLocalConfig): VoiceTtsLocalConfig {
  const out = { ...base };
  if (typeof raw.modelId === 'string' && raw.modelId.trim()) out.modelId = raw.modelId.trim();
  if (raw.deviceMap === 'auto' || raw.deviceMap === 'cpu' || raw.deviceMap === 'cuda:0') {
    out.deviceMap = raw.deviceMap;
  }
  if (
    raw.dtype === 'auto' ||
    raw.dtype === 'bfloat16' ||
    raw.dtype === 'float16' ||
    raw.dtype === 'float32'
  ) {
    out.dtype = raw.dtype;
  }
  if (
    raw.attnImplementation === 'auto' ||
    raw.attnImplementation === 'flash_attention_2' ||
    raw.attnImplementation === 'sdpa' ||
    raw.attnImplementation === 'eager'
  ) {
    out.attnImplementation = raw.attnImplementation;
  }
  if (typeof raw.tokenizerModelId === 'string' && raw.tokenizerModelId.trim()) {
    out.tokenizerModelId = raw.tokenizerModelId.trim();
  }
  if (raw.mode === 'custom_voice' || raw.mode === 'voice_design' || raw.mode === 'voice_clone') {
    out.mode = raw.mode;
  }
  if (raw.customVoice && typeof raw.customVoice === 'object') {
    const cv = raw.customVoice as Record<string, unknown>;
    if (typeof cv.speaker === 'string' && cv.speaker.trim()) {
      out.customVoice.speaker = cv.speaker.trim();
    }
    if (typeof cv.language === 'string') out.customVoice.language = cv.language.trim();
    if (typeof cv.instruct === 'string') out.customVoice.instruct = cv.instruct;
  }
  if (raw.voiceDesign && typeof raw.voiceDesign === 'object') {
    const vd = raw.voiceDesign as Record<string, unknown>;
    if (typeof vd.language === 'string') out.voiceDesign.language = vd.language.trim();
    if (typeof vd.instruct === 'string') out.voiceDesign.instruct = vd.instruct;
  }
  if (raw.voiceClone && typeof raw.voiceClone === 'object') {
    const vc = raw.voiceClone as Record<string, unknown>;
    if (typeof vc.refAudioPath === 'string') out.voiceClone.refAudioPath = vc.refAudioPath.trim();
    if (typeof vc.refText === 'string') out.voiceClone.refText = vc.refText;
    if (typeof vc.xVectorOnlyMode === 'boolean') {
      out.voiceClone.xVectorOnlyMode = vc.xVectorOnlyMode;
    }
    if (typeof vc.language === 'string') out.voiceClone.language = vc.language.trim();
    if (typeof vc.savedPromptId === 'string') {
      out.voiceClone.savedPromptId = vc.savedPromptId.trim();
    }
  }
  if (raw.generation && typeof raw.generation === 'object') {
    const gen = raw.generation as Record<string, unknown>;
    out.generation.maxNewTokens = clampNum(gen.maxNewTokens, 256, 4096, out.generation.maxNewTokens);
    out.generation.topP = clampNum(gen.topP, 0, 1, out.generation.topP);
    out.generation.topK = clampNum(gen.topK, 0, 100, out.generation.topK);
    out.generation.temperature = clampNum(gen.temperature, 0, 2, out.generation.temperature);
    out.generation.repetitionPenalty = clampNum(
      gen.repetitionPenalty,
      0,
      2,
      out.generation.repetitionPenalty,
    );
  }
  if (raw.streaming && typeof raw.streaming === 'object') {
    const st = raw.streaming as Record<string, unknown>;
    out.streaming = {
      emitEveryFrames: clampNum(st.emitEveryFrames, 1, 32, out.streaming?.emitEveryFrames ?? 8),
      decodeWindowFrames: clampNum(st.decodeWindowFrames, 16, 256, out.streaming?.decodeWindowFrames ?? 80),
      firstChunkEmitEvery: clampNum(
        st.firstChunkEmitEvery,
        1,
        32,
        out.streaming?.firstChunkEmitEvery ?? 5,
      ),
      firstChunkDecodeWindow: clampNum(
        st.firstChunkDecodeWindow,
        16,
        256,
        out.streaming?.firstChunkDecodeWindow ?? 48,
      ),
      overlapSamples: clampNum(st.overlapSamples, 0, 4096, out.streaming?.overlapSamples ?? 512),
      repetitionPenalty: clampNum(
        st.repetitionPenalty,
        0.5,
        2,
        out.streaming?.repetitionPenalty ?? 1.05,
      ),
    };
  } else if (!out.streaming) {
    out.streaming = defaultTtsLocalStreaming();
  }
  if (isQwen06bCustomVoice(out.modelId)) {
    out.customVoice.instruct = '';
  }
  return out;
}

function parseTtsProvider(raw: Record<string, unknown>, base: VoiceTtsProviderConfig): VoiceTtsProviderConfig {
  const out = { ...base };
  const voices = new Set([
    'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse',
  ]);
  const formats = new Set(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']);
  if (typeof raw.providerId === 'string') out.providerId = raw.providerId.trim();
  if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.trim();
  if (typeof raw.voice === 'string' && raw.voice.trim()) {
    const voice = raw.voice.trim().toLowerCase();
    out.voice = voices.has(voice) ? voice : out.voice;
  }
  out.speed = clampNum(raw.speed, 0.25, 4, out.speed);
  if (typeof raw.format === 'string' && formats.has(raw.format.trim().toLowerCase())) {
    out.format = raw.format.trim().toLowerCase() as VoiceTtsProviderConfig['format'];
  }
  return out;
}

function parseTtsBrowser(raw: Record<string, unknown>, base: VoiceTtsBrowserConfig): VoiceTtsBrowserConfig {
  const out = { ...base };
  if (typeof raw.voiceUri === 'string') out.voiceUri = raw.voiceUri.trim();
  out.rate = clampNum(raw.rate, 0.25, 4, out.rate);
  out.pitch = clampNum(raw.pitch, 0, 2, out.pitch);
  out.volume = clampNum(raw.volume, 0, 1, out.volume);
  return out;
}

function syncLegacySttFields(stt: VoiceSttConfig): void {
  if (stt.backend === 'provider') {
    stt.providerId = stt.provider.providerId;
    stt.model = stt.provider.model;
    stt.language = stt.provider.language;
    return;
  }
  stt.providerId = '';
  stt.model = stt.backend === 'builtin' ? 'Xenova/whisper-tiny' : stt.local.modelId;
  stt.language = stt.local.language;
}

function syncLegacyTtsFields(tts: VoiceTtsConfig): void {
  if (tts.backend === 'provider') {
    tts.providerId = tts.provider.providerId;
    tts.model = tts.provider.model;
    tts.voice = tts.provider.voice;
    tts.speed = tts.provider.speed;
    tts.format = tts.provider.format;
    return;
  }
  if (tts.backend === 'browser') {
    tts.providerId = 'browser';
    tts.model = '';
    tts.voice = tts.browser.voiceUri;
    tts.speed = tts.browser.rate;
    tts.format = 'wav';
    return;
  }
  tts.providerId = '';
  tts.model = tts.local.modelId;
  tts.voice = tts.local.customVoice.speaker;
  tts.speed = 1;
  tts.format = 'wav';
}

function parseVoiceBlock(raw: unknown): VoiceConfig {
  const defaults = createDefaultVoiceConfig(false);
  if (!raw || typeof raw !== 'object') return structuredClone(defaults);

  const block = raw as Record<string, unknown>;
  const audioRaw =
    block.audio && typeof block.audio === 'object'
      ? (block.audio as Record<string, unknown>)
      : {};
  const sttRaw =
    block.stt && typeof block.stt === 'object'
      ? (block.stt as Record<string, unknown>)
      : {};
  const ttsRaw =
    block.tts && typeof block.tts === 'object'
      ? (block.tts as Record<string, unknown>)
      : {};
  const limitsRaw =
    block.limits && typeof block.limits === 'object'
      ? (block.limits as Record<string, unknown>)
      : {};

  const audio: VoiceAudioConfig = {
    ...defaults.audio,
    inputDeviceId:
      typeof audioRaw.inputDeviceId === 'string' ? audioRaw.inputDeviceId.trim() : '',
    outputDeviceId:
      typeof audioRaw.outputDeviceId === 'string' ? audioRaw.outputDeviceId.trim() : '',
    echoCancellation:
      typeof audioRaw.echoCancellation === 'boolean'
        ? audioRaw.echoCancellation
        : defaults.audio.echoCancellation,
    noiseSuppression:
      typeof audioRaw.noiseSuppression === 'boolean'
        ? audioRaw.noiseSuppression
        : defaults.audio.noiseSuppression,
    autoGainControl:
      typeof audioRaw.autoGainControl === 'boolean'
        ? audioRaw.autoGainControl
        : defaults.audio.autoGainControl,
  };

  const stt: VoiceSttConfig = {
    ...defaults.stt,
    local: parseSttLocal(
      sttRaw.local && typeof sttRaw.local === 'object'
        ? (sttRaw.local as Record<string, unknown>)
        : {},
      defaults.stt.local,
    ),
    provider: parseSttProvider(
      sttRaw.provider && typeof sttRaw.provider === 'object'
        ? (sttRaw.provider as Record<string, unknown>)
        : {},
      defaults.stt.provider,
    ),
  };

  if (typeof sttRaw.enabled === 'boolean') stt.enabled = sttRaw.enabled;

  if (typeof sttRaw.providerId === 'string' && sttRaw.providerId.trim()) {
    stt.provider.providerId = sttRaw.providerId.trim();
  }
  if (typeof sttRaw.model === 'string' && sttRaw.model.trim() && !sttRaw.local) {
    stt.provider.model = sttRaw.model.trim();
  }
  if (typeof sttRaw.language === 'string' && sttRaw.language.trim() && !sttRaw.local) {
    stt.provider.language = sttRaw.language.trim();
  }

  if (sttRaw.backend === 'builtin' || sttRaw.backend === 'local' || sttRaw.backend === 'provider') {
    stt.backend = sttRaw.backend;
  } else if (stt.provider.providerId) {
    stt.backend = 'provider';
  } else {
    stt.backend = defaults.stt.backend;
  }

  const tts: VoiceTtsConfig = {
    ...defaults.tts,
    local: parseTtsLocal(
      ttsRaw.local && typeof ttsRaw.local === 'object'
        ? (ttsRaw.local as Record<string, unknown>)
        : {},
      defaults.tts.local,
    ),
    provider: parseTtsProvider(
      ttsRaw.provider && typeof ttsRaw.provider === 'object'
        ? (ttsRaw.provider as Record<string, unknown>)
        : {},
      defaults.tts.provider,
    ),
    browser: parseTtsBrowser(
      ttsRaw.browser && typeof ttsRaw.browser === 'object'
        ? (ttsRaw.browser as Record<string, unknown>)
        : {},
      defaults.tts.browser,
    ),
  };

  if (typeof ttsRaw.enabled === 'boolean') tts.enabled = ttsRaw.enabled;
  if (typeof ttsRaw.streaming === 'boolean') tts.streaming = ttsRaw.streaming;

  if (typeof ttsRaw.providerId === 'string' && ttsRaw.providerId.trim()) {
    const pid = ttsRaw.providerId.trim();
    if (pid === 'browser') {
      tts.backend = 'browser';
    } else {
      tts.provider.providerId = pid;
    }
  }
  if (typeof ttsRaw.model === 'string' && ttsRaw.model.trim() && !ttsRaw.local) {
    tts.provider.model = ttsRaw.model.trim();
  }
  if (typeof ttsRaw.voice === 'string' && ttsRaw.voice.trim() && !ttsRaw.local) {
    tts.provider.voice = ttsRaw.voice.trim().toLowerCase();
  }
  if (typeof ttsRaw.speed === 'number' && Number.isFinite(ttsRaw.speed) && !ttsRaw.provider) {
    tts.provider.speed = clampNum(ttsRaw.speed, 0.25, 4, 1);
  }
  if (typeof ttsRaw.format === 'string' && ttsRaw.format.trim() && !ttsRaw.provider) {
    tts.provider.format = ttsRaw.format.trim().toLowerCase() as VoiceTtsProviderConfig['format'];
  }

  if (
    ttsRaw.backend === 'local' ||
    ttsRaw.backend === 'provider' ||
    ttsRaw.backend === 'browser'
  ) {
    tts.backend = ttsRaw.backend;
  } else if (tts.provider.providerId) {
    tts.backend = 'provider';
  } else if (ttsRaw.providerId === 'browser') {
    tts.backend = 'browser';
  } else {
    tts.backend = defaults.tts.backend;
  }

  const limits: VoiceLimitsConfig = {
    maxAudioBytes:
      typeof limitsRaw.maxAudioBytes === 'number' && Number.isFinite(limitsRaw.maxAudioBytes)
        ? Math.max(1024, Math.round(limitsRaw.maxAudioBytes))
        : defaults.limits.maxAudioBytes,
    maxDurationSeconds:
      typeof limitsRaw.maxDurationSeconds === 'number' &&
      Number.isFinite(limitsRaw.maxDurationSeconds)
        ? Math.max(1, Math.round(limitsRaw.maxDurationSeconds))
        : defaults.limits.maxDurationSeconds,
    silenceTimeoutSeconds:
      typeof limitsRaw.silenceTimeoutSeconds === 'number' &&
      Number.isFinite(limitsRaw.silenceTimeoutSeconds)
        ? Math.max(0, Math.min(30, limitsRaw.silenceTimeoutSeconds))
        : defaults.limits.silenceTimeoutSeconds,
  };

  syncLegacySttFields(stt);
  syncLegacyTtsFields(tts);

  return { audio, stt, tts, limits };
}

// ── Persist ──────────────────────────────────────────────────────────────────

function readLocalVoiceMeta(): VoiceConfig {
  try {
    const raw = localStorage.getItem(VOICE_META_STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_VOICE_CONFIG);
    return parseVoiceBlock(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_VOICE_CONFIG);
  }
}

function writeLocalVoiceMeta(config: VoiceConfig): void {
  localStorage.setItem(VOICE_META_STORAGE_KEY, JSON.stringify(config));
}

async function fetchVoiceFromServer(): Promise<VoiceConfig> {
  const voiceRes = await fetch('/api/voice/config', { cache: 'no-store' });
  if (voiceRes.ok) return parseVoiceBlock(await voiceRes.json());
  const res = await fetch('/api/config/meta', { cache: 'no-store' });
  if (!res.ok) return readLocalVoiceMeta();
  const meta = (await res.json()) as Record<string, unknown>;
  return parseVoiceBlock(meta.voice);
}

/** Load voice config (cached until reset). */
export async function loadVoiceMeta(): Promise<VoiceConfig> {
  if (cachedVoice) return cachedVoice;
  const serverUp = await detectConfigServer();
  cachedVoice = serverUp ? await fetchVoiceFromServer() : readLocalVoiceMeta();
  writeLocalVoiceMeta(cachedVoice);
  return cachedVoice;
}

export function getVoiceMetaSync(): VoiceConfig {
  return cachedVoice ?? readLocalVoiceMeta();
}

export function resetVoiceMetaCache(): void {
  cachedVoice = null;
}

/** Deep-merge patch for nested voice config blocks. */
export type VoiceMetaPatch = {
  audio?: Partial<VoiceAudioConfig>;
  stt?: Partial<Omit<VoiceSttConfig, 'local' | 'provider'>> & {
    local?: Partial<VoiceSttLocalConfig>;
    provider?: Partial<VoiceSttProviderConfig>;
  };
  tts?: Partial<Omit<VoiceTtsConfig, 'local' | 'provider' | 'browser'>> & {
    local?: Partial<VoiceTtsLocalConfig> & {
      customVoice?: Partial<VoiceTtsCustomVoiceConfig>;
      voiceDesign?: Partial<VoiceTtsVoiceDesignConfig>;
      voiceClone?: Partial<VoiceTtsVoiceCloneConfig>;
      generation?: Partial<VoiceTtsGenerationConfig>;
    };
    provider?: Partial<VoiceTtsProviderConfig>;
    browser?: Partial<VoiceTtsBrowserConfig>;
  };
  limits?: Partial<VoiceLimitsConfig>;
};

// ── Merge ────────────────────────────────────────────────────────────────────

function mergeVoiceConfig(current: VoiceConfig, patch: VoiceMetaPatch): VoiceConfig {
  const merged = parseVoiceBlock({
    audio: { ...current.audio, ...patch.audio },
    stt: {
      ...current.stt,
      ...patch.stt,
      local: { ...current.stt.local, ...patch.stt?.local },
      provider: { ...current.stt.provider, ...patch.stt?.provider },
    },
    tts: {
      ...current.tts,
      ...patch.tts,
      local: {
        ...current.tts.local,
        ...patch.tts?.local,
        customVoice: {
          ...current.tts.local.customVoice,
          ...patch.tts?.local?.customVoice,
        },
        voiceDesign: {
          ...current.tts.local.voiceDesign,
          ...patch.tts?.local?.voiceDesign,
        },
        voiceClone: {
          ...current.tts.local.voiceClone,
          ...patch.tts?.local?.voiceClone,
        },
        generation: {
          ...current.tts.local.generation,
          ...patch.tts?.local?.generation,
        },
      },
      provider: { ...current.tts.provider, ...patch.tts?.provider },
      browser: { ...current.tts.browser, ...patch.tts?.browser },
    },
    limits: { ...current.limits, ...patch.limits },
  });
  return merged;
}

/** Persist partial voice config via PUT /api/config/meta. */
export async function saveVoiceMeta(patch: VoiceMetaPatch): Promise<VoiceConfig | null> {
  const serverUp = await detectConfigServer();
  if (!serverUp) return null;

  const current = await loadVoiceMeta();
  const merged = mergeVoiceConfig(current, patch);
  const res = await fetch('/api/config/meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice: merged }),
  });
  if (!res.ok) return null;
  cachedVoice = await fetchVoiceFromServer();
  writeLocalVoiceMeta(cachedVoice);
  return cachedVoice;
}
