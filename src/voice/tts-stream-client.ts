/**
 * Browser WebSocket client for live local TTS — Int16 PCM mono over WS.
 */

import { withSessionToken } from '../api/session-token.ts';

const MAX_TTS_WS_MESSAGE_CHARS = 64 * 1024;

export type TtsStreamServerEvent =
  | { type: 'ready'; sampleRate: number }
  | { type: 'final'; durationMs?: number }
  | { type: 'error'; message: string };

export interface TtsStreamClientCallbacks {
  onReady?: (sampleRate: number) => void;
  onChunk?: (pcm: ArrayBuffer) => void;
  onFinal?: (durationMs?: number) => void;
  onError?: (message: string) => void;
}

export interface TtsStreamStartOptions {
  voice?: string;
  speed?: number;
}

/** Parse a server TTS WebSocket JSON event. */
export function parseTtsServerMessage(raw: string): TtsStreamServerEvent | null {
  if (raw.length > MAX_TTS_WS_MESSAGE_CHARS) return null;
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (!msg || typeof msg.type !== 'string') return null;
    if (msg.type === 'ready' && typeof msg.sampleRate === 'number') {
      return { type: 'ready', sampleRate: msg.sampleRate };
    }
    if (msg.type === 'final') {
      const durationMs =
        typeof msg.durationMs === 'number' && Number.isFinite(msg.durationMs)
          ? msg.durationMs
          : undefined;
      return durationMs != null ? { type: 'final', durationMs } : { type: 'final' };
    }
    if (msg.type === 'error' && typeof msg.message === 'string') {
      return { type: 'error', message: msg.message };
    }
    return null;
  } catch {
    return null;
  }
}

/** Build same-origin WebSocket URL for TTS streaming. */
export function buildTtsWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return withSessionToken(`${proto}//${window.location.host}/api/tts/ws`);
}

/**
 * Live TTS session: opens WS, sends text, receives PCM chunks until final.
 */
export class TtsStreamClient {
  private ws: WebSocket | null = null;
  private callbacks: TtsStreamClientCallbacks;
  private closed = false;

  constructor(callbacks: TtsStreamClientCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /** Open WS and stream synthesis for the given text; resolves on server ready. */
  async start(text: string, options: TtsStreamStartOptions = {}): Promise<void> {
    if (this.ws) return;
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Nothing to synthesize');
    }

    this.closed = false;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(buildTtsWsUrl());
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let ready = false;

      ws.onopen = () => {
        const payload: Record<string, unknown> = { type: 'start', text: trimmed };
        if (options.voice) payload.voice = options.voice;
        if (typeof options.speed === 'number' && Number.isFinite(options.speed)) {
          payload.speed = options.speed;
        }
        ws.send(JSON.stringify(payload));
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const parsed = parseTtsServerMessage(event.data);
          if (!parsed) return;
          this.handleServerEvent(parsed, () => {
            ready = true;
            resolve();
          }, reject);
          return;
        }
        if (event.data instanceof ArrayBuffer && event.data.byteLength > 0) {
          this.callbacks.onChunk?.(event.data);
        }
      };

      ws.onerror = () => {
        if (!ready) {
          reject(new Error('TTS WebSocket connection failed'));
        } else {
          this.callbacks.onError?.('TTS WebSocket connection failed');
        }
      };

      ws.onclose = () => {
        this.ws = null;
        if (!ready && !this.closed) {
          reject(new Error('TTS WebSocket closed before ready'));
        } else if (ready && !this.closed) {
          this.callbacks.onError?.('Speech stream ended before audio was complete');
        }
      };
    });
  }

  /** Request server cancel and close the socket. */
  cancel(): void {
    this.closed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'cancel' }));
      } catch {}
    }
    this.close();
  }

  /** Tear down the socket without sending cancel. */
  close(): void {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  private handleServerEvent(
    event: TtsStreamServerEvent,
    onReady: () => void,
    onStartError: (err: Error) => void,
  ): void {
    switch (event.type) {
      case 'ready':
        this.callbacks.onReady?.(event.sampleRate);
        onReady();
        break;
      case 'final':
        this.callbacks.onFinal?.(event.durationMs);
        this.close();
        break;
      case 'error':
        this.callbacks.onError?.(event.message);
        onStartError(new Error(event.message));
        this.close();
        break;
      default:
        break;
    }
  }
}
