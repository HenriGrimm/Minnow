import { loadVoiceMeta } from '../config/voice-meta';
import { AudioPlaybackQueue } from '../voice/audio-playback-queue';
import { TtsStreamClient } from '../voice/tts-stream-client';
import { setStatus } from './status';
import { openModels } from './models-page';
import { extractSpeechText } from './voice-speech-text.ts';
import { iconHtml } from './icon';
import { ensureVoiceWorker } from '../voice/api-client';

export { extractSpeechText } from './voice-speech-text.ts';

export interface SttStatus {
  enabled: boolean;
  backend?: 'builtin' | 'local' | 'provider';
  providerId: string;
  model: string;
  language: string;
  healthy: boolean;
  modelId?: string;
  runtimeReady?: boolean;
  modelLoaded?: boolean;
  cudaAvailable?: boolean;
  streaming?: boolean;
  streamingSupported?: boolean;
  warning?: string | null;
  builtin?: { phase: string; progress: number | null; cached: boolean; error: string | null };
}

export interface TtsStatus {
  enabled: boolean;
  backend?: 'local' | 'provider' | 'browser';
  providerId: string;
  model: string;
  voice: string;
  speed: number;
  format: string;
  browser: boolean;
  healthy: boolean;
  modelId?: string;
  mode?: string;
  runtimeReady?: boolean;
  modelLoaded?: boolean;
  streaming?: boolean;
  streamingSupported?: boolean;
  warning?: string | null;
}

let cachedSttStatus: SttStatus | null = null;
let cachedTtsStatus: TtsStatus | null = null;
let cachedOutputDeviceId = '';
let currentAudio: HTMLAudioElement | null = null;
let currentPlayButton: HTMLButtonElement | null = null;
let currentTtsStreamClient: TtsStreamClient | null = null;
let currentAudioQueue: AudioPlaybackQueue | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;
let cancelCurrentStream: (() => void) | null = null;

/** Fetch STT availability from the tool server. */
export async function fetchSttStatus(): Promise<SttStatus | null> {
  try {
    const res = await fetch('/api/stt/status', { cache: 'no-store' });
    if (!res.ok) return null;
    const status = (await res.json()) as SttStatus;
    cachedSttStatus = status;
    return status;
  } catch {
    return null;
  }
}

/** Fetch TTS availability from the tool server. */
export async function fetchTtsStatus(): Promise<TtsStatus | null> {
  try {
    const res = await fetch('/api/tts/status', { cache: 'no-store' });
    if (!res.ok) return null;
    const status = (await res.json()) as TtsStatus;
    cachedTtsStatus = status;
    return status;
  } catch {
    return null;
  }
}

export function getCachedTtsStatus(): TtsStatus | null {
  return cachedTtsStatus;
}

export function getCachedSttStatus(): SttStatus | null {
  return cachedSttStatus;
}

function stopCurrentPlayback(): void {
  const cancel = cancelCurrentStream;
  cancelCurrentStream = null;
  cancel?.();
  currentUtterance = null;
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  currentTtsStreamClient?.cancel();
  currentTtsStreamClient = null;
  currentAudioQueue?.stop();
  currentAudioQueue = null;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
  if (currentPlayButton) {
    currentPlayButton.classList.remove('voice-play-btn--loading');
    currentPlayButton.setAttribute('aria-label', 'Read aloud');
    currentPlayButton = null;
  }
}

export async function speakStreamingText(text: string): Promise<void> {
  const plain = extractSpeechText(text);
  if (!plain) {
    throw new Error('Nothing to read aloud');
  }

  let status = await fetchTtsStatus();
  if (!status?.enabled) {
    throw new Error('Text-to-speech is disabled. Open Models → Voice.');
  }

  const backend = status.backend ?? (status.browser ? 'browser' : 'provider');
  if (backend !== 'local') {
    throw new Error('Streaming TTS requires local backend with streaming enabled');
  }

  if (!status.healthy) {
    await ensureVoiceWorker();
    status = await fetchTtsStatus();
    if (!status?.healthy) throw new Error(status?.warning ?? 'Local TTS worker is not ready');
  }
  if (!status.streamingSupported) {
    throw new Error('Streaming TTS is disabled in settings');
  }

  stopCurrentPlayback();
  await playAssistantTextStreaming(plain);
}

/** Play local TTS via WebSocket PCM stream + gapless Web Audio queue. */
async function playAssistantTextStreaming(
  plain: string,
  button?: HTMLButtonElement,
): Promise<void> {
  const queue = new AudioPlaybackQueue({
    outputDeviceId: cachedOutputDeviceId,
    onPlaybackStart: () => {
      if (currentAudioQueue !== queue) return;
      button?.classList.remove('voice-play-btn--loading');
      button?.setAttribute('aria-label', 'Stop reading');
      setStatus('ok', 'Reading aloud…');
    },
    onBuffering: () => {
      if (currentAudioQueue === queue) setStatus('spin', 'Buffering speech…');
    },
  });
  currentAudioQueue = queue;
  let chunkCount = 0;

  await new Promise<void>((resolve, reject) => {
    cancelCurrentStream = resolve;
    const client = new TtsStreamClient({
      onReady: (sampleRate) => {
        queue.setSampleRate(sampleRate);
        button?.setAttribute('aria-label', 'Stop preparing speech');
        setStatus('spin', 'Preparing smooth playback…');
      },
      onChunk: (pcm) => {
        chunkCount += 1;
        void queue.enqueue(pcm).catch(reject);
      },
      onFinal: async () => {
        try {
          if (chunkCount === 0) {
            reject(new Error('Streaming TTS returned no audio'));
            return;
          }
          await queue.drain();
          if (currentAudioQueue !== queue) return;
          stopCurrentPlayback();
          setStatus('ok', 'Finished reading');
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error('Could not play audio'));
        }
      },
      onError: (message) => {
        reject(new Error(message));
      },
    });
    currentTtsStreamClient = client;
    void client.start(plain).catch(reject);
  });
}

/** Play text with browser speechSynthesis fallback. */
export function speakWithBrowser(
  text: string,
  voiceUri = '',
  rate = 1,
  pitch = 1,
  volume = 1,
  button?: HTMLButtonElement,
): void {
  if (!('speechSynthesis' in window)) {
    setStatus('err', 'Browser speech is not supported here');
    return;
  }
  stopCurrentPlayback();
  const utterance = new SpeechSynthesisUtterance(text);
  currentUtterance = utterance;
  if (button) {
    currentPlayButton = button;
    button.classList.remove('voice-play-btn--loading');
    button.setAttribute('aria-label', 'Stop reading');
  }
  utterance.rate = Math.min(4, Math.max(0.25, rate));
  utterance.pitch = Math.min(2, Math.max(0, pitch));
  utterance.volume = Math.min(1, Math.max(0, volume));
  const voices = window.speechSynthesis.getVoices();
  if (voiceUri) {
    const match = voices.find((v) => v.voiceURI === voiceUri || v.name === voiceUri);
    if (match) utterance.voice = match;
  } else {
    const local = voices.find((v) => v.localService && v.default) ?? voices.find((v) => v.localService);
    if (local) utterance.voice = local;
  }
  utterance.onend = () => {
    if (currentUtterance !== utterance) return;
    stopCurrentPlayback();
    setStatus('ok', 'Finished reading');
  };
  utterance.onerror = () => {
    if (currentUtterance !== utterance) return;
    stopCurrentPlayback();
    setStatus('err', 'System speech is unavailable. Choose a voice in Models → Voice.');
  };
  window.speechSynthesis.speak(utterance);
  setStatus('ok', 'Reading aloud…');
}

/** Request synthesized audio bytes from the server. */
export async function synthesizeSpeech(
  text: string,
  options?: { voice?: string; speed?: number; format?: string },
): Promise<Blob> {
  const res = await fetch('/api/tts/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voice: options?.voice,
      speed: options?.speed,
      format: options?.format,
      returnBytes: true,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message =
      typeof err.error === 'string' ? err.error : 'Speech synthesis failed';
    throw new Error(message);
  }
  return res.blob();
}

/** Apply configured output device when the browser supports setSinkId. */
async function applyOutputDevice(audio: HTMLAudioElement): Promise<void> {
  if (!cachedOutputDeviceId) return;
  const sinkable = audio as HTMLAudioElement & {
    setSinkId?: (id: string) => Promise<void>;
  };
  if (typeof sinkable.setSinkId !== 'function') return;
  try {
    await sinkable.setSinkId(cachedOutputDeviceId);
  } catch {
  }
}

/** Play assistant message text via configured TTS (never autoplay). */
export async function playAssistantText(
  text: string,
  button?: HTMLButtonElement,
): Promise<void> {
  if (button && currentPlayButton === button && (currentUtterance || currentAudioQueue)) {
    stopCurrentPlayback();
    setStatus('ok', 'Stopped reading');
    return;
  }
  const plain = extractSpeechText(text);
  if (!plain) {
    setStatus('err', 'Nothing to read aloud');
    return;
  }

  let status = await fetchTtsStatus();
  if (!status?.enabled) {
    setStatus('err', 'Text-to-speech is disabled. Open Models → Voice.');
    openModels('voice');
    return;
  }

  if (button) {
    stopCurrentPlayback();
    currentPlayButton = button;
    button.classList.add('voice-play-btn--loading');
    button.setAttribute('aria-label', 'Loading speech');
  }

  try {
    const backend = status.backend ?? (status.browser ? 'browser' : 'provider');

    if (backend === 'browser' || status.browser || status.providerId === 'browser') {
      const voiceMeta = await loadVoiceMeta();
      speakWithBrowser(
        plain,
        voiceMeta.tts.browser.voiceUri || status.voice,
        voiceMeta.tts.browser.rate ?? status.speed,
        voiceMeta.tts.browser.pitch,
        voiceMeta.tts.browser.volume,
        button,
      );
      return;
    }

    if (backend === 'local') {
      if (!status.healthy) {
        setStatus('spin', 'Starting voice…');
        await ensureVoiceWorker();
        status = await fetchTtsStatus();
        if (!status?.healthy) throw new Error(status?.warning ?? 'Local voice could not start');
      }
      if (status.streamingSupported) {
        try {
          await playAssistantTextStreaming(plain, button);
          return;
        } catch {
          stopCurrentPlayback();
          if (button) {
            currentPlayButton = button;
            button.classList.add('voice-play-btn--loading');
            button.setAttribute('aria-label', 'Loading speech');
          }
        }
      }
      const blob = await synthesizeSpeech(plain);
      stopCurrentPlayback();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      if (button) currentPlayButton = button;
      await applyOutputDevice(audio);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        stopCurrentPlayback();
        setStatus('ok', 'Finished reading');
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        stopCurrentPlayback();
        setStatus('err', 'Could not play audio');
      };
      await audio.play();
      setStatus('ok', 'Reading aloud…');
      return;
    }

    if (!status.healthy) {
      setStatus('err', 'TTS provider is not configured. Open Models → Voice.');
      openModels('voice');
      return;
    }

    const blob = await synthesizeSpeech(plain, {
      voice: status.voice,
      speed: status.speed,
      format: status.format,
    });
    stopCurrentPlayback();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    if (button) currentPlayButton = button;
    await applyOutputDevice(audio);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      stopCurrentPlayback();
      setStatus('ok', 'Finished reading');
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      stopCurrentPlayback();
      setStatus('err', 'Could not play audio');
    };
    await audio.play();
    setStatus('ok', 'Reading aloud…');
  } catch (err) {
    stopCurrentPlayback();
    const message = err instanceof Error ? err.message : 'Speech failed';
    setStatus('err', message);
    if (message.includes('Settings') || message.includes('Models')) {
      openModels('voice');
    }
  }
}

/** Attach a read-aloud button to a completed assistant message row. */
export function attachVoicePlayButton(wrap: HTMLElement, text: string): void {
  if (wrap.dataset.streaming === 'true') return;
  if (wrap.querySelector('.voice-play-btn')) return;
  const plain = extractSpeechText(text);
  if (!plain) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'voice-play-btn message-actions__trigger';
  btn.setAttribute('aria-label', 'Read aloud');
  btn.title = 'Read aloud';
  btn.innerHTML = iconHtml('speaker');

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void playAssistantText(text, btn);
  });

  wrap.classList.add('msg--has-actions');
  wrap.append(btn);
}

/** Prime voice status caches on boot. */
export async function initVoiceStatus(): Promise<void> {
  try {
    const voiceMeta = await loadVoiceMeta();
    cachedOutputDeviceId = voiceMeta.audio.outputDeviceId ?? '';
  } catch {
    cachedOutputDeviceId = '';
  }
  await Promise.all([fetchSttStatus(), fetchTtsStatus()]);
  if (cachedSttStatus?.enabled && cachedSttStatus.backend === 'builtin' && cachedSttStatus.builtin?.cached) {
    void fetch('/api/stt/prepare', { method: 'POST' }).catch(() => {});
  }
}
