/**
 * Composer mic button — voice server boot loading and error feedback.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { registerComposerSurface } = await import('../../src/ui/composer-surface.ts');

let domWindow: Window | null = null;
let originalFetch: typeof globalThis.fetch;
let originalGetUserMedia: typeof navigator.mediaDevices.getUserMedia | undefined;

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

function fetchPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  return input.url;
}

function setupDom(): void {
  const window = new Window();
  domWindow = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  globalThis.Node = window.Node;
  globalThis.window = window as unknown as Window & typeof globalThis;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });

  document.body.innerHTML = `
    <button type="button" id="attachBtn"></button>
    <textarea id="msgInput"></textarea>
    <div id="sDot"></div>
    <div id="sText"></div>
    <div id="osStatusDot"></div>
    <div id="osStatusText"></div>
  `;

  const inputEl = document.getElementById('msgInput') as HTMLTextAreaElement;
  registerComposerSurface('code', {
    inputEl,
    sendBtnEl: null,
  });
}

function mockGetUserMedia(): void {
  const stream = {
    getTracks: () => [{ stop: () => undefined }],
  } as unknown as MediaStream;

  originalGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: async () => stream,
    },
    configurable: true,
  });

  class MockMediaRecorder {
    static isTypeSupported = () => true;
    state = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start(): void {
      this.state = 'recording';
    }
    stop(): void {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
      this.onstop?.();
    }
  }

  globalThis.MediaRecorder = MockMediaRecorder as unknown as typeof MediaRecorder;
}

afterEach(async () => {
  try {
    const { stopRecording, getMicState } = await import('../../src/ui/composer-voice.ts');
    if (getMicState() !== 'idle') {
      stopRecording();
      await waitFor(() => getMicState() === 'idle', 500);
    }
  } catch {
    /* module may not be loaded yet */
  }
  domWindow?.close();
  domWindow = null;
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
  if (originalGetUserMedia && navigator.mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: originalGetUserMedia },
      configurable: true,
    });
  }
});

describe('composer-voice mic boot states', () => {
  test('shows starting spinner while local voice worker boots', async () => {
    setupDom();
    mockGetUserMedia();
    originalFetch = globalThis.fetch;

    const unhealthyStt = {
      enabled: true,
      backend: 'local',
      providerId: 'local',
      model: 'whisper-small',
      language: 'en',
      healthy: false,
      streamingSupported: false,
    };
    const healthyStt = {
      ...unhealthyStt,
      healthy: true,
    };
    const stoppedRuntime = {
      installed: true,
      running: false,
      health: 'stopped',
      cudaAvailable: false,
      torchVariant: 'cpu',
      port: null,
      installedAt: null,
      installedPackages: [],
      skippedPackages: [],
      installJob: null,
      worker: { ok: false, status: 'stopped' },
    };
    const readyRuntime = {
      ...stoppedRuntime,
      running: true,
      health: 'ready',
      port: 8765,
      worker: { ok: true, status: 'ready', port: 8765 },
    };

    let sttCalls = 0;
    let runtimeCalls = 0;
    let resolveRuntimeReady: (() => void) | null = null;

    globalThis.fetch = async (input, init) => {
      const url = fetchPath(input);
      if (url.includes('/api/stt/status')) {
        sttCalls += 1;
        const body = sttCalls === 1 ? unhealthyStt : healthyStt;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (url.includes('/api/voice/runtime/start') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, port: 8765 }), { status: 200 });
      }
      if (url.includes('/api/voice/runtime/status')) {
        runtimeCalls += 1;
        if (runtimeCalls < 2) {
          await new Promise<void>((resolve) => {
            resolveRuntimeReady = resolve;
          });
        }
        const body = runtimeCalls < 2 ? stoppedRuntime : readyRuntime;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (url.includes('/api/stt/transcribe') && init?.method === 'POST') {
        return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const { initComposerVoice, getMicState } = await import('../../src/ui/composer-voice.ts');
    initComposerVoice();

    const micBtn = document.getElementById('btnComposerMic') as HTMLButtonElement;
    assert.ok(micBtn, 'composer mic button is mounted');

    micBtn.click();
    await waitFor(() => getMicState() === 'starting' && resolveRuntimeReady !== null);

    assert.equal(getMicState(), 'starting');
    assert.equal(micBtn.classList.contains('composer-mic-btn--busy'), true);
    assert.equal(micBtn.getAttribute('aria-busy'), 'true');
    assert.equal(micBtn.title, 'Starting voice…');
    assert.equal(document.getElementById('sText')?.textContent, 'Starting voice…');

    resolveRuntimeReady?.();
    await waitFor(() => getMicState() === 'recording');

    assert.equal(getMicState(), 'recording');
    assert.equal(micBtn.classList.contains('composer-mic-btn--busy'), false);
  });

  test('flashes error state when voice worker fails to start', async () => {
    setupDom();
    mockGetUserMedia();
    originalFetch = globalThis.fetch;

    const unhealthyStt = {
      enabled: true,
      backend: 'local',
      providerId: 'local',
      model: 'whisper-small',
      language: 'en',
      healthy: false,
      streamingSupported: false,
    };
    const stoppedRuntime = {
      installed: true,
      running: false,
      health: 'stopped',
      cudaAvailable: false,
      torchVariant: 'cpu',
      port: null,
      installedAt: null,
      installedPackages: [],
      skippedPackages: [],
      installJob: null,
      worker: { ok: false, status: 'stopped' },
    };
    const errorRuntime = {
      ...stoppedRuntime,
      health: 'error',
      worker: { ok: false, status: 'error' },
    };

    globalThis.fetch = async (input, init) => {
      const url = fetchPath(input);
      if (url.includes('/api/stt/status')) {
        return new Response(JSON.stringify(unhealthyStt), { status: 200 });
      }
      if (url.includes('/api/voice/runtime/start') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('/api/voice/runtime/status')) {
        return new Response(JSON.stringify(errorRuntime), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const { initComposerVoice, getMicState } = await import('../../src/ui/composer-voice.ts');
    initComposerVoice();

    const micBtn = document.getElementById('btnComposerMic') as HTMLButtonElement;
    micBtn.click();
    await waitFor(() => getMicState() === 'idle' && micBtn.classList.contains('composer-mic-btn--error'));

    assert.equal(getMicState(), 'idle');
    assert.equal(micBtn.classList.contains('composer-mic-btn--error'), true);
    assert.match(document.getElementById('sText')?.textContent ?? '', /failed to start/i);
  });

  test('ignores mic clicks while voice server is starting', async () => {
    setupDom();
    mockGetUserMedia();
    originalFetch = globalThis.fetch;

    const unhealthyStt = {
      enabled: true,
      backend: 'local',
      providerId: 'local',
      model: 'whisper-small',
      language: 'en',
      healthy: false,
      streamingSupported: false,
    };
    const stoppedRuntime = {
      installed: true,
      running: false,
      health: 'stopped',
      cudaAvailable: false,
      torchVariant: 'cpu',
      port: null,
      installedAt: null,
      installedPackages: [],
      skippedPackages: [],
      installJob: null,
      worker: { ok: false, status: 'stopped' },
    };
    const errorRuntime = {
      ...stoppedRuntime,
      health: 'error',
      worker: { ok: false, status: 'error' },
    };

    let startCalls = 0;
    let runtimeCalls = 0;
    let releaseRuntimePoll: (() => void) | null = null;

    globalThis.fetch = async (input, init) => {
      const url = fetchPath(input);
      if (url.includes('/api/stt/status')) {
        return new Response(JSON.stringify(unhealthyStt), { status: 200 });
      }
      if (url.includes('/api/voice/runtime/start') && init?.method === 'POST') {
        startCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('/api/voice/runtime/status')) {
        runtimeCalls += 1;
        if (runtimeCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseRuntimePoll = resolve;
          });
          return new Response(JSON.stringify(stoppedRuntime), { status: 200 });
        }
        return new Response(JSON.stringify(errorRuntime), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const { initComposerVoice, getMicState } = await import('../../src/ui/composer-voice.ts');
    initComposerVoice();

    const micBtn = document.getElementById('btnComposerMic') as HTMLButtonElement;
    micBtn.click();
    await waitFor(() => getMicState() === 'starting' && releaseRuntimePoll !== null);
    micBtn.click();
    releaseRuntimePoll?.();
    await waitFor(() => getMicState() === 'idle');
    assert.equal(startCalls, 1, 'voice worker start is only requested once');
  });

  test('built-in dictation records while preparation is still pending and never starts Python', async () => {
    setupDom();
    mockGetUserMedia();
    originalFetch = globalThis.fetch;
    const requests: string[] = [];
    let finishPrepare: (() => void) | undefined;
    globalThis.fetch = async (input) => {
      const url = fetchPath(input);
      requests.push(url);
      if (url.includes('/api/stt/status')) {
        return Response.json({ enabled: true, backend: 'builtin', healthy: true, modelLoaded: false });
      }
      if (url.includes('/api/stt/prepare')) {
        await new Promise<void>((resolve) => { finishPrepare = resolve; });
        return Response.json({ phase: 'loading' });
      }
      return new Response('not found', { status: 404 });
    };
    const { initComposerVoice, getMicState } = await import('../../src/ui/composer-voice.ts');
    initComposerVoice();
    (document.getElementById('btnComposerMic') as HTMLButtonElement).click();
    await waitFor(() => getMicState() === 'recording');
    assert.ok(finishPrepare, 'model preparation started');
    assert.equal(requests.some((url) => url.includes('/api/voice/runtime')), false);
    finishPrepare?.();
  });

  test('disabled dictation returns to idle so settings can be changed and retried', async () => {
    setupDom();
    mockGetUserMedia();
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ enabled: false });
    const { initComposerVoice, getMicState } = await import('../../src/ui/composer-voice.ts');
    initComposerVoice();
    (document.getElementById('btnComposerMic') as HTMLButtonElement).click();
    await waitFor(() => getMicState() === 'idle');
    assert.equal(document.getElementById('btnComposerMic')?.getAttribute('aria-busy'), 'false');
  });
});
