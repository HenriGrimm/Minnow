import { streamFetch } from './stream-fetch';

/** EventSource-compatible SSE subscriptions over the shared socket. */
export class StreamEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly withCredentials = false;
  readonly url: string;
  readyState: number = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  private controller = new AbortController();
  private retry = 3000;
  private lastEventId = '';
  private timer?: ReturnType<typeof setTimeout>;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    void this.connect();
  }

  addEventListener<K extends keyof EventSourceEventMap>(
    type: K, listener: (event: EventSourceEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: any, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, listener, options);
  }

  close(): void {
    this.readyState = this.CLOSED;
    clearTimeout(this.timer);
    this.controller.abort();
  }

  private emit(event: Event): void {
    this.dispatchEvent(event);
    if (event.type === 'open') this.onopen?.(event);
    else if (event.type === 'error') this.onerror?.(event);
    else if (event.type === 'message') this.onmessage?.(event as MessageEvent);
  }

  private async connect(): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await streamFetch(this.url, {
        signal: this.controller.signal,
        headers: this.lastEventId ? { 'Last-Event-ID': this.lastEventId } : {},
      });
      if (this.controller.signal.aborted) return;
      if (response.status === 204 || (response.status >= 400 && response.status < 500)) {
        await response.body?.cancel();
        this.close(); this.emit(new Event('error')); return;
      }
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        await response.body?.cancel();
        throw new Error('Invalid event stream response');
      }
      reader = response.body!.getReader();
      this.readyState = this.OPEN;
      this.emit(new Event('open'));
      const decoder = new TextDecoder();
      let buffer = '';
      let data: string[] = [];
      let eventType = '';
      let eventSize = 0;
      // Parse lines incrementally, including CRLF split between transport chunks.
      const line = (value: string) => {
        if (!value) {
          if (data.length) this.emit(new MessageEvent(eventType || 'message', {
            data: data.join('\n'), lastEventId: this.lastEventId,
            origin: new URL(this.url, globalThis.location?.href ?? 'http://localhost').origin,
          }));
          data = []; eventType = ''; eventSize = 0; return;
        }
        const colon = value.indexOf(':');
        const field = colon < 0 ? value : value.slice(0, colon);
        const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') { data.push(content); eventSize += content.length; }
        else if (field === 'event') eventType = content;
        else if (field === 'id' && !content.includes('\0')) this.lastEventId = content;
        else if (field === 'retry' && /^\d+$/.test(content)) this.retry = Math.min(60_000, Math.max(250, Number(content)));
      };
      while (!this.controller.signal.aborted) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (buffer.length + eventSize > 8 * 1024 * 1024) {
          throw new Error('Event stream frame too large');
        }
        let match: RegExpExecArray | null;
        while ((match = /\r\n|\r|\n/.exec(buffer))) {
          if (!done && match[0] === '\r' && match.index === buffer.length - 1) break;
          line(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
          if (this.controller.signal.aborted) return;
        }
        if (done) break;
      }
    } catch {
      // Generation subscriptions own replay; EventSource consumers reconnect here.
    } finally {
      try { await reader?.cancel(); reader?.releaseLock(); } catch {}
    }
    if (this.controller.signal.aborted) return;
    this.readyState = this.CONNECTING;
    this.emit(new Event('error'));
    if (!this.controller.signal.aborted) this.timer = setTimeout(() => void this.connect(), this.retry);
  }
}
