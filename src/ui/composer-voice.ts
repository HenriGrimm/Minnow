import { getActiveComposerSurface } from './composer-surface';
import { autoResize } from './input';
import { setStatus } from './status';
import { openModels } from './models-page';
import { loadVoiceMeta } from '../config/voice-meta';
import { recordedBlobToWav } from '../voice/recorded-audio';
import { connectMicAnalyser, watchSilence } from '../voice/silence-detector';
import { DictationRange } from '../voice/dictation-range';
import { SttStreamClient } from '../voice/stt-stream-client';
import { ensureVoiceWorker } from '../voice/api-client';
import { fetchSttStatus } from './voice-controls';
import { iconHtml } from './icon';

export type MicState = 'idle' | 'starting' | 'recording' | 'transcribing';

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: BlobPart[] = [];
let recordingStream: MediaStream | null = null;
let sttStreamClient: SttStreamClient | null = null;
let dictationRange: DictationRange | null = null;
let useStreamingStt = false;
let useBuiltinStt = false;
let micState: MicState = 'idle';
let recordingTimer: ReturnType<typeof setInterval> | null = null;
let recordingStartedAt = 0;
let maxDurationSeconds = 300;
let silenceTimeoutSeconds = 2.5;
let inputDeviceId = '';
let echoCancellation = true;
let noiseSuppression = true;
let autoGainControl = true;
let micAnalyserDisconnect: (() => void) | null = null;
let stopSilenceWatch: (() => void) | null = null;
let micDetecting = false;
let micErrorFlashTimer: ReturnType<typeof setTimeout> | null = null;
/** Composer textarea pinned when dictation starts (avoids stale routing on async stop). */
let dictationInputEl: HTMLTextAreaElement | null = null;

const MIC_BUTTON_IDS = ['btnComposerMic', 'btnChatAppMic', 'btnDesktopMic'] as const;

const MIC_BUTTON_MARKUP =
  '<span class="composer-mic-btn__ring" aria-hidden="true"></span>' +
  '<span class="composer-mic-btn__bars" aria-hidden="true">' +
  '<span></span><span></span><span></span>' +
  '</span>' +
  iconHtml('mic', { className: 'composer-mic-btn__icon' }) +
  '<span class="composer-mic-btn__spinner" aria-hidden="true"></span>';

// ── Input ────────────────────────────────────────────────────────────────────

function resizeComposerInput(input: HTMLTextAreaElement): void {
  autoResize(input);
}

/** Insert transcribed text at the caret in a textarea (batch path). */
function insertTranscript(input: HTMLTextAreaElement, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const spacer =
    before && !before.endsWith(' ') && !trimmed.startsWith(' ')
      ? ' '
      : '';
  input.value = `${before}${spacer}${trimmed}${after}`;
  const caret = before.length + spacer.length + trimmed.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  resizeComposerInput(input);
  input.focus();
}

function resolveDictationInput(): HTMLTextAreaElement | null {
  return dictationInputEl ?? getActiveComposerSurface().inputEl;
}

/** Toggle dictation styling on the active composer textarea. */
function setComposerDictating(active: boolean): void {
  resolveDictationInput()?.classList.toggle('composer-dictating', active);
}

function clearDictationInput(): void {
  dictationInputEl = null;
}

function clearMicErrorFlash(): void {
  if (micErrorFlashTimer) {
    clearTimeout(micErrorFlashTimer);
    micErrorFlashTimer = null;
  }
  for (const id of MIC_BUTTON_IDS) {
    document.getElementById(id)?.classList.remove('composer-mic-btn--error');
  }
}

/** Brief error accent on mic buttons after voice server or mic failures. */
function flashMicError(): void {
  clearMicErrorFlash();
  for (const id of MIC_BUTTON_IDS) {
    document.getElementById(id)?.classList.add('composer-mic-btn--error');
  }
  micErrorFlashTimer = setTimeout(() => {
    clearMicErrorFlash();
  }, 2_500);
}

// ── Mic ──────────────────────────────────────────────────────────────────────

/** Sync visual classes and ARIA on every composer mic button. */
function setMicButtonsState(state: MicState): void {
  micState = state;
  if (state === 'idle') {
    clearMicErrorFlash();
  }
  if (state !== 'recording') {
    setMicDetecting(false);
    stopSilenceMonitor();
    setComposerDictating(false);
  }
  for (const id of MIC_BUTTON_IDS) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.classList.toggle('composer-mic-btn--recording', state === 'recording');
    btn.classList.toggle(
      'composer-mic-btn--busy',
      state === 'transcribing' || state === 'starting',
    );
    btn.setAttribute(
      'aria-busy',
      state === 'transcribing' || state === 'starting' ? 'true' : 'false',
    );
    btn.setAttribute(
      'aria-label',
      state === 'recording'
        ? 'Listening — pauses auto-submit, or click to stop'
        : state === 'transcribing'
          ? 'Transcribing speech'
          : state === 'starting'
            ? 'Starting voice'
            : 'Dictate with microphone',
    );
    btn.title =
      state === 'recording'
        ? useStreamingStt
          ? 'Listening… words appear as you speak'
          : 'Listening… pause to transcribe'
        : state === 'transcribing'
          ? 'Transcribing…'
          : state === 'starting'
            ? 'Starting voice…'
            : 'Dictate';
    if (state !== 'recording') {
      btn.style.removeProperty('--mic-level');
    }
  }
}

/** Toggle the short “hearing audio” accent while the mic is open. */
function setMicDetecting(active: boolean): void {
  if (micDetecting === active) return;
  micDetecting = active;
  for (const id of MIC_BUTTON_IDS) {
    document.getElementById(id)?.classList.toggle('composer-mic-btn--detecting', active);
  }
}

function stopSilenceMonitor(): void {
  stopSilenceWatch?.();
  stopSilenceWatch = null;
  micAnalyserDisconnect?.();
  micAnalyserDisconnect = null;
}

/** Drive mic level UI and auto-stop after a pause in speech. */
function startSilenceMonitor(stream: MediaStream): void {
  stopSilenceMonitor();
  if (typeof AudioContext === 'undefined') return;

  try {
    const { analyser, disconnect } = connectMicAnalyser(stream);
    micAnalyserDisconnect = disconnect;
    const silenceMs = Math.round(silenceTimeoutSeconds * 1000);

    stopSilenceWatch = watchSilence(analyser, {
      silenceTimeoutMs: silenceMs,
      onLevel: (level, speaking) => {
        setMicDetecting(speaking);
        for (const id of MIC_BUTTON_IDS) {
          const btn = document.getElementById(id);
          if (btn) btn.style.setProperty('--mic-level', level.toFixed(3));
        }
      },
      onSilenceTimeout: () => {
        if (micState !== 'recording') return;
        setStatus(
          'spin',
          useStreamingStt ? 'Pause detected — finishing…' : 'Pause detected — transcribing…',
        );
        stopRecording();
      },
    });
  } catch {
    stopSilenceMonitor();
  }
}

function clearRecordingTimer(): void {
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
}

function stopMediaTracks(): void {
  if (recordingStream) {
    for (const track of recordingStream.getTracks()) {
      track.stop();
    }
    recordingStream = null;
  }
}

function armRecordingTimer(): void {
  clearRecordingTimer();
  recordingTimer = setInterval(() => {
    const elapsed = (Date.now() - recordingStartedAt) / 1000;
    if (elapsed >= maxDurationSeconds) {
      stopRecording();
      setStatus('err', `Recording stopped at ${maxDurationSeconds}s limit`);
    }
  }, 500);
}

// ── Transcribe ───────────────────────────────────────────────────────────────

async function transcribeBlob(blob: Blob): Promise<string> {
  const wavBlob = await recordedBlobToWav(blob);
  const form = new FormData();
  form.append('file', wavBlob, 'audio.wav');
  const res = await fetch('/api/stt/transcribe', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message =
      typeof err.error === 'string' ? err.error : 'Transcription failed';
    throw new Error(message);
  }
  const data = (await res.json()) as { text?: string };
  return typeof data.text === 'string' ? data.text.trim() : '';
}

/** Apply live dictation text to the composer and resize. */
function renderDictation(input: HTMLTextAreaElement): void {
  if (!dictationRange) return;
  dictationRange.render(input);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  resizeComposerInput(input);
  input.focus();
}

async function handleBatchRecordingStop(): Promise<void> {
  stopMediaTracks();
  clearRecordingTimer();
  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  audioChunks = [];
  mediaRecorder = null;

  if (!blob.size) {
    setMicButtonsState('idle');
    setStatus('err', 'No audio captured');
    return;
  }

  setMicButtonsState('transcribing');
  setStatus('spin', 'Transcribing…');
  const progressTimer = useBuiltinStt ? setInterval(() => {
    void fetchSttStatus().then((status) => {
      if (micState !== 'transcribing' || status?.builtin?.phase !== 'loading') return;
      const percent = status.builtin.progress;
      setStatus('spin', percent == null
        ? 'Preparing speech model for first use…'
        : `Downloading speech model… ${percent}%`);
    });
  }, 1_000) : null;
  try {
    const text = await transcribeBlob(blob);
    const inputEl = resolveDictationInput();
    if (text && inputEl) {
      insertTranscript(inputEl, text);
      setStatus('ok', 'Transcribed');
    } else {
      setStatus('err', 'No speech detected');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Transcription failed';
    setStatus('err', message);
    if (message.includes('Settings') || message.includes('provider') || message.includes('Models')) {
      openModels('voice');
    }
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    clearDictationInput();
    setMicButtonsState('idle');
  }
}

async function handleStreamingRecordingStop(): Promise<void> {
  clearRecordingTimer();
  const client = sttStreamClient;
  const range = dictationRange;
  sttStreamClient = null;
  dictationRange = null;
  const inputEl = resolveDictationInput();

  if (!client) {
    clearDictationInput();
    setMicButtonsState('idle');
    return;
  }

  if (!inputEl) {
    clearDictationInput();
    setMicButtonsState('idle');
    setStatus('err', 'Composer input not found');
    return;
  }

  setStatus('spin', 'Finishing dictation…');
  try {
    const finalText = await client.stop();
    if (range) {
      range.setFinal(finalText);
      range.render(inputEl);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      autoResize(inputEl);
    }
    if (finalText.trim()) {
      setStatus('ok', 'Transcribed');
    } else {
      range?.restore(inputEl);
      setStatus('err', 'No speech detected');
    }
  } catch (err) {
    range?.restore(inputEl);
    const message = err instanceof Error ? err.message : 'Transcription failed';
    setStatus('err', message);
    if (message.includes('Settings') || message.includes('Models')) {
      openModels('voice');
    }
  } finally {
    clearDictationInput();
    setMicButtonsState('idle');
    inputEl?.focus();
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

async function startStreamingRecording(): Promise<void> {
  const inputEl = resolveDictationInput();
  if (!inputEl) {
    setStatus('err', 'Composer input not found');
    return;
  }
  dictationRange = new DictationRange();
  dictationRange.start(inputEl);
  setComposerDictating(true);

  const client = new SttStreamClient({
    inputDeviceId,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    onSegment: (text) => {
      dictationRange?.applySegment(text);
      renderDictation(inputEl);
    },
    onPartial: (text) => {
      dictationRange?.setInterim(text);
      renderDictation(inputEl);
    },
    onFinal: (text) => {
      dictationRange?.setFinal(text);
      renderDictation(inputEl);
    },
    onError: (message) => {
      setStatus('err', message);
    },
  });
  sttStreamClient = client;

  setStatus('spin', 'Loading model…');
  await client.start();

  recordingStream = client.getMediaStream();
  recordingStartedAt = Date.now();
  setMicButtonsState('recording');
  if (recordingStream) {
    startSilenceMonitor(recordingStream);
  }
  setStatus(
    'ok',
    silenceTimeoutSeconds > 0
      ? `Listening… stop talking for ${silenceTimeoutSeconds}s to finish`
      : 'Listening… click mic to stop',
  );
  armRecordingTimer();
}

async function startBatchRecording(): Promise<void> {
  const audioConstraints: MediaTrackConstraints = {
    echoCancellation,
    noiseSuppression,
    autoGainControl,
  };
  if (inputDeviceId) {
    audioConstraints.deviceId = { exact: inputDeviceId };
  }
  recordingStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  mediaRecorder = new MediaRecorder(recordingStream, { mimeType });
  audioChunks = [];
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) audioChunks.push(event.data);
  };
  mediaRecorder.onstop = () => {
    void handleBatchRecordingStop();
  };
  mediaRecorder.onerror = () => {
    setMicButtonsState('idle');
    stopMediaTracks();
    setStatus('err', 'Recording failed');
  };
  mediaRecorder.start();
  recordingStartedAt = Date.now();
  setMicButtonsState('recording');
  startSilenceMonitor(recordingStream);
  setStatus(
    'ok',
    silenceTimeoutSeconds > 0
      ? `Listening… stop talking for ${silenceTimeoutSeconds}s to transcribe`
      : 'Listening… click mic to stop',
  );
  armRecordingTimer();
}

async function startRecording(): Promise<void> {
  if (micState !== 'idle') return;

  if (!window.isSecureContext) {
    setStatus('err', 'Microphone requires HTTPS or localhost');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('err', 'Microphone is not supported in this browser');
    return;
  }

  setMicButtonsState('starting');
  let status = await fetchSttStatus();
  if (!status?.enabled) {
    setMicButtonsState('idle');
    setStatus('err', 'Speech-to-text is disabled. Open Models → Voice.');
    openModels('voice');
    return;
  }

  if (!status.healthy && status.backend === 'local') {
    setMicButtonsState('starting');
    setStatus('spin', 'Starting voice…');
    try {
      await ensureVoiceWorker();
      status = await fetchSttStatus();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Voice server could not start';
      setMicButtonsState('idle');
      flashMicError();
      setStatus('err', message);
      openModels('voice');
      return;
    }
  }

  if (!status?.healthy) {
    const message =
      status?.backend === 'local'
        ? (status.warning ?? 'Voice worker is not ready. Open Models → Voice.')
        : 'STT provider is not configured. Open Models → Voice.';
    setMicButtonsState('idle');
    flashMicError();
    setStatus('err', message);
    openModels('voice');
    return;
  }

  useStreamingStt = status.backend === 'local' && status.streamingSupported === true;
  useBuiltinStt = status.backend === 'builtin';
  if (useBuiltinStt) {
    // Capture immediately while the model downloads/loads in the background.
    void fetch('/api/stt/prepare', { method: 'POST' }).catch(() => {});
  }

  const { inputEl } = getActiveComposerSurface();
  if (!inputEl) {
    setMicButtonsState('idle');
    setStatus('err', 'Composer input not found');
    return;
  }
  dictationInputEl = inputEl;

  try {
    if (useStreamingStt) {
      await startStreamingRecording();
      return;
    }
    await startBatchRecording();
  } catch (err) {
    sttStreamClient?.close();
    sttStreamClient = null;
    dictationRange = null;
    stopMediaTracks();
    clearDictationInput();
    setMicButtonsState('idle');
    const error = err as DOMException;
    if (error?.name === 'NotAllowedError') {
      setStatus('err', 'Microphone access denied');
      return;
    }
    if (error?.name === 'NotFoundError') {
      setStatus('err', 'No microphone found');
      return;
    }
    const message = err instanceof Error ? err.message : 'Could not access microphone';
    setStatus('err', message);
    if (message.includes('Settings') || message.includes('Models')) {
      openModels('voice');
    }
  }
}

/** Stop an active recording if one is in progress. */
export function stopRecording(): void {
  if (useStreamingStt && sttStreamClient && micState === 'recording') {
    void handleStreamingRecordingStop();
    return;
  }
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  setMicButtonsState('idle');
  stopMediaTracks();
  clearRecordingTimer();
}

// ── Init ─────────────────────────────────────────────────────────────────────

function onMicClick(): void {
  if (micState === 'recording') {
    stopRecording();
    return;
  }
  if (micState === 'transcribing' || micState === 'starting') return;
  void startRecording();
}

function upgradeMicButton(btn: HTMLButtonElement): void {
  if (btn.id === 'btnDesktopMic') {
    btn.classList.remove('attach-btn', 'input-inset-btn');
    btn.classList.add('mn-os-desktop-comp-btn');
  } else {
    btn.classList.remove('attach-btn');
    btn.classList.add('input-inset-btn');
  }
  if (!btn.querySelector('.composer-mic-btn__icon')) {
    btn.innerHTML = MIC_BUTTON_MARKUP;
  }
  if (!btn.dataset.micBound) {
    btn.addEventListener('click', onMicClick);
    btn.dataset.micBound = '1';
  }
}

function ensureMicButton(id: string, anchorId: string): void {
  const existing = document.getElementById(id);
  if (existing instanceof HTMLButtonElement) {
    upgradeMicButton(existing);
    return;
  }
  const anchor = document.getElementById(anchorId);
  if (!anchor?.parentElement) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = id;
  btn.className =
    id === 'btnDesktopMic'
      ? 'mn-os-desktop-comp-btn composer-mic-btn'
      : 'input-inset-btn composer-mic-btn';
  btn.setAttribute('aria-label', 'Dictate with microphone');
  btn.setAttribute('aria-busy', 'false');
  btn.title = 'Dictate';
  btn.innerHTML = MIC_BUTTON_MARKUP;
  btn.addEventListener('click', onMicClick);
  btn.dataset.micBound = '1';
  anchor.insertAdjacentElement('afterend', btn);
}

/** Mount mic buttons on Code, Chat, and desktop composer surfaces. */
export function initComposerVoice(): void {
  ensureMicButton('btnComposerMic', 'attachBtn');
  ensureMicButton('btnChatAppMic', 'btnChatAppAttach');
  ensureMicButton('btnDesktopMic', 'btnDesktopAttach');

  void (async () => {
    try {
      const voiceMeta = await loadVoiceMeta();
      inputDeviceId = voiceMeta.audio.inputDeviceId ?? '';
      echoCancellation = voiceMeta.audio.echoCancellation ?? true;
      noiseSuppression = voiceMeta.audio.noiseSuppression ?? true;
      autoGainControl = voiceMeta.audio.autoGainControl ?? true;
      const seconds = voiceMeta.limits?.maxDurationSeconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds)) {
        maxDurationSeconds = Math.max(1, Math.round(seconds));
      }
      const silence = voiceMeta.limits?.silenceTimeoutSeconds;
      if (typeof silence === 'number' && Number.isFinite(silence)) {
        silenceTimeoutSeconds = Math.max(0, Math.min(30, silence));
      }
    } catch {
    }
    try {
      const res = await fetch('/api/config/meta', { cache: 'no-store' });
      if (!res.ok) return;
      const meta = (await res.json()) as {
        voice?: {
          audio?: {
            echoCancellation?: boolean;
            noiseSuppression?: boolean;
            autoGainControl?: boolean;
          };
          limits?: { maxDurationSeconds?: number; silenceTimeoutSeconds?: number };
        };
      };
      const seconds = meta.voice?.limits?.maxDurationSeconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds)) {
        maxDurationSeconds = Math.max(1, Math.round(seconds));
      }
      const silence = meta.voice?.limits?.silenceTimeoutSeconds;
      if (typeof silence === 'number' && Number.isFinite(silence)) {
        silenceTimeoutSeconds = Math.max(0, Math.min(30, silence));
      }
      const audio = meta.voice?.audio;
      if (typeof audio?.echoCancellation === 'boolean') {
        echoCancellation = audio.echoCancellation;
      }
      if (typeof audio?.noiseSuppression === 'boolean') {
        noiseSuppression = audio.noiseSuppression;
      }
      if (typeof audio?.autoGainControl === 'boolean') {
        autoGainControl = audio.autoGainControl;
      }
    } catch {
    }
  })();
}

export function getMicState(): MicState {
  return micState;
}

