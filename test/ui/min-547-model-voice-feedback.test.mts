import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';
import { Window } from 'happy-dom';
import { readFileSync, readdirSync } from 'node:fs';

mock.module('../../src/ui/status.ts', { namedExports: { setStatus() {} } });
mock.module('../../src/ui/models-page.ts', { namedExports: { openModels() {} } });
mock.module('../../src/ui/input.ts', { namedExports: { autoResize() {} } });
mock.module('../../src/ui/composer-surface.ts', { namedExports: {
  getActiveComposerSurface: () => ({ inputEl: document.querySelector('textarea'), sendBtnEl: null }),
} });
mock.module('../../src/config/voice-meta.ts', { namedExports: {
  loadVoiceMeta: async () => ({ audio: {}, tts: { browser: {} } }),
} });

let queueOptions: any;
mock.module('../../src/voice/audio-playback-queue.ts', { namedExports: {
  AudioPlaybackQueue: class {
    constructor(options: any) { queueOptions = options; }
    setSampleRate() {}
    stop() {}
    async enqueue() {}
    async drain() {}
  },
} });
let streamOptions: any;
let finishDictation: (text: string) => void;
mock.module('../../src/voice/stt-stream-client.ts', { namedExports: {
  SttStreamClient: class {
    async start() {}
    getMediaStream() { return null; }
    stop() { return new Promise<string>(r => { finishDictation = r; }); }
  },
} });
mock.module('../../src/voice/tts-stream-client.ts', { namedExports: {
  TtsStreamClient: class {
    constructor(options: any) { streamOptions = options; }
    async start() { streamOptions.onReady(24000); }
    cancel() {}
  },
} });

const { playAssistantText } = await import('../../src/ui/voice-controls.ts');
const { withButtonBusy } = await import('../../src/ui/models/dom.ts');
const originalFetch = globalThis.fetch;
const originalAudio = globalThis.Audio;
let win: Window;

function setup() {
  win = new Window();
  globalThis.window = win as any;
  globalThis.document = win.document as any;
  return document.createElement('button');
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.Audio = originalAudio;
  win?.close();
});
const status = (extra = {}) => Response.json({
  enabled: true, backend: 'provider', healthy: true, ...extra,
});

test('audit leaves only error status calls in scoped callers', () => {
  const paths = ['src/api/models.ts', 'src/ui/composer-voice.ts', 'src/ui/voice-controls.ts',
    ...readdirSync('src/ui/models').filter(p => p.endsWith('.ts')).map(p => 'src/ui/models/' + p)];
  for (const path of paths) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /setStatus\(\s*['"](ok|idle|spin)['"]/, path);
  }
});

test('busy model controls restore state after success and failure and ignore double activation', async () => {
  const button = setup();
  button.textContent = 'Build';
  let finish!: () => void;
  const pending = withButtonBusy(button, 'Starting build…', () => new Promise<void>(r => { finish = r; }));
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  let duplicate = false;
  await withButtonBusy(button, 'Again', async () => { duplicate = true; });
  assert.equal(duplicate, false);
  finish();
  await pending;
  assert.equal(button.textContent, 'Build');
  assert.equal(button.disabled, false);
  await assert.rejects(withButtonBusy(button, 'Working…', async () => { throw new Error('failed'); }));
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(button.textContent, 'Build');
});

test('read-aloud spinner covers availability and synthesis, supports cancellation, and clears on completion', async () => {
  const button = setup();
  let finishStatus!: (r: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(r => { finishStatus = r; })) as any;
  const cancelled = playAssistantText('Hello', button);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  await playAssistantText('Hello', button);
  finishStatus(status());
  await cancelled;
  assert.equal(button.getAttribute('aria-busy'), 'false');

  let finishSynthesis!: (r: Response) => void;
  let audio: any;
  globalThis.Audio = class {
    onended?: () => void;
    src = '';
    constructor() { audio = this; }
    async play() {}
    pause() {}
  } as any;
  globalThis.fetch = (async (input: any) => String(input).includes('/status') ? status()
    : new Promise<Response>(r => { finishSynthesis = r; })) as any;
  const pending = playAssistantText('Hello', button);
  while (!finishSynthesis) await new Promise(r => setTimeout(r, 0));
  assert.equal(button.getAttribute('aria-busy'), 'true');
  finishSynthesis(new Response(new Blob(['audio'])));
  await pending;
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(button.getAttribute('aria-label'), 'Stop reading');
  audio.onended();
  assert.equal(button.getAttribute('aria-label'), 'Read aloud');
});

test('streaming read-aloud exposes preparing, playing, buffering and stop locally', async () => {
  const button = setup();
  globalThis.fetch = (async () => status({ backend: 'local', streamingSupported: true })) as any;
  const pending = playAssistantText('Hello', button);
  while (!streamOptions) await new Promise(r => setTimeout(r, 0));
  assert.equal(button.getAttribute('aria-busy'), 'true');
  queueOptions.onPlaybackStart();
  assert.equal(button.getAttribute('aria-busy'), 'false');
  queueOptions.onBuffering();
  assert.equal(button.getAttribute('aria-busy'), 'true');
  await playAssistantText('Hello', button);
  await pending;
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(button.getAttribute('aria-label'), 'Read aloud');
  streamOptions.onReady(24000);
  assert.equal(button.getAttribute('aria-busy'), 'false', 'late stream callbacks stay cancelled');
});

test('stream failure falls back to batch synthesis without losing busy feedback', async () => {
  const button = setup();
  streamOptions = undefined;
  let finishSynthesis!: (r: Response) => void;
  globalThis.Audio = class {
    src = '';
    async play() {}
    pause() {}
  } as any;
  globalThis.fetch = (async (input: any) => String(input).includes('/status')
    ? status({ backend: 'local', streamingSupported: true })
    : new Promise<Response>(r => { finishSynthesis = r; })) as any;
  const pending = playAssistantText('Hello', button);
  while (!streamOptions) await new Promise(r => setTimeout(r, 0));
  streamOptions.onError('stream failed');
  while (!finishSynthesis) await new Promise(r => setTimeout(r, 0));
  assert.equal(button.getAttribute('aria-busy'), 'true');
  finishSynthesis(new Response(new Blob(['audio'])));
  await pending;
  assert.equal(button.getAttribute('aria-label'), 'Stop reading');
  assert.equal(button.getAttribute('aria-busy'), 'false');
  await playAssistantText('Hello', button);
});

test('streaming dictation keeps the mic busy while final text is pending and restores idle', async () => {
  setup();
  Object.assign(globalThis, {
    HTMLElement: win.HTMLElement, HTMLButtonElement: win.HTMLButtonElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement, Event: win.Event,
  });
  Object.defineProperty(win, 'isSecureContext', { value: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true, value: { getUserMedia: async () => null },
  });
  document.body.innerHTML = '<div id="composerInsetActions"></div><textarea id="msgInput"></textarea>';
  const inputEl = document.querySelector('textarea')!;
  globalThis.fetch = (async () => Response.json({
    enabled: true, backend: 'local', healthy: true, streamingSupported: true,
  })) as any;
  const { initComposerVoice, getMicState, stopRecording } = await import('../../src/ui/composer-voice.ts');
  initComposerVoice();
  const mic = document.getElementById('btnComposerMic') as HTMLButtonElement;
  mic.click();
  while (getMicState() !== 'recording') await new Promise(r => setTimeout(r, 0));
  stopRecording();
  assert.equal(getMicState(), 'transcribing');
  assert.equal(mic.getAttribute('aria-busy'), 'true');
  assert.equal(mic.classList.contains('composer-mic-btn--busy'), true);
  assert.equal(mic.title, 'Finishing dictation…');
  mic.click();
  assert.equal(getMicState(), 'transcribing');
  finishDictation('Hello dictation');
  while (getMicState() !== 'idle') await new Promise(r => setTimeout(r, 0));
  assert.equal(mic.getAttribute('aria-busy'), 'false');
  assert.equal(inputEl.value, 'Hello dictation');
});
