/** Shared happy-dom globals for OS tests under node --test. */

import {
  createEmptyChatObject,
  setSessionStateForTests,
  type Chat,
} from '../../src/state/sessions.ts';

type HappyWindow = import('happy-dom').Window;

/** Bind browser globals from a happy-dom window onto globalThis. */
export function installHappyDomGlobals(
  win: HappyWindow,
  options?: { fetch?: typeof fetch },
): void {
  const g = globalThis as typeof globalThis & {
    window: Window;
    document: Document;
    HTMLElement: typeof HTMLElement;
    HTMLButtonElement: typeof HTMLButtonElement;
    Document: typeof Document;
    Node: typeof Node;
    localStorage: Storage;
    requestAnimationFrame: typeof requestAnimationFrame;
    getComputedStyle: typeof getComputedStyle;
    fetch?: typeof fetch;
  };
  g.window = win as unknown as Window & typeof globalThis.window;
  g.document = win.document;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.HTMLButtonElement = win.HTMLButtonElement;
  g.Document = win.Document;
  g.Node = win.Node;
  g.localStorage = win.localStorage;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  g.requestAnimationFrame = (cb: FrameRequestCallback) =>
    win.setTimeout(() => cb(win.performance.now()), 0) as unknown as number;
  // happy-dom lacks ResizeObserver; several UIs expect it in node tests.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    g.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
    win.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
  win.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    onchange: null,
  })) as typeof window.matchMedia;
  if (options?.fetch) {
    win.fetch = options.fetch;
    g.fetch = options.fetch;
  }
}

/** Inline layout so getComputedStyle returns stable line metrics in happy-dom. */
export function prepareDesktopComposerField(field: HTMLTextAreaElement): void {
  field.style.boxSizing = 'border-box';
  field.style.padding = '10px 12px';
  field.style.lineHeight = '1.35';
  field.style.fontSize = '16px';
  field.style.width = '400px';
  field.style.border = '0';
}

/** happy-dom does not lay out textarea scrollHeight; stub it for resize tests. */
export function stubTextareaScrollHeight(field: HTMLTextAreaElement, px: number): void {
  Object.defineProperty(field, 'scrollHeight', { value: px, configurable: true });
}

/** Flush pending timers/microtasks, then close the happy-dom window. */
export async function teardownHappyDomAsync(win: HappyWindow): Promise<void> {
  await new Promise((r) => setTimeout(r, 120));
  win.close();
}

/** Minimal composer + main column nodes used by sidebar/switchChat tests. */
export function setupMinimalComposerDom(doc: Document): void {
  for (const id of ['chatArea', 'mainColumn']) {
    const el = doc.createElement('div');
    el.id = id;
    doc.body.appendChild(el);
  }

  const msgInput = doc.createElement('textarea');
  msgInput.id = 'msgInput';
  doc.body.appendChild(msgInput);

  const sendBtn = doc.createElement('button');
  sendBtn.id = 'sendBtn';
  sendBtn.type = 'button';
  doc.body.appendChild(sendBtn);
}

/** Stub Electron preview IPC used by file-layout and link-routing tests. */
export function installMinnowPreviewMock(win: HappyWindow): void {
  const w = win as unknown as Window & typeof globalThis;
  w.minnow = {
    preview: {
      hide: () => undefined,
      show: async () => undefined,
      loadURL: async () => undefined,
      navigateAndWait: async () => ({ ok: true }),
      onNavigation: () => () => undefined,
      onLoading: () => () => undefined,
      onLoadFailed: () => () => undefined,
    },
  };
}

/** happy-dom globals shared by benchmark UI harness tests. */
export function installBenchmarkTestGlobals(win: HappyWindow): void {
  installHappyDomGlobals(win);
  const g = globalThis as typeof globalThis & {
    performance: Performance;
    CSS: typeof CSS;
  };
  g.performance = win.performance;
  g.CSS = win.CSS;
}

/** Seed v5 session state with a single empty chat for UI harness tests. */
export function seedMinimalSession(activeId?: string): Chat {
  const chat = createEmptyChatObject('');
  if (activeId) {
    chat.id = activeId;
  }
  setSessionStateForTests({
    version: 5,
    activeId: chat.id,
    sidebarCollapsed: false,
    groups: [],
    chats: [chat],
    lastActiveChatIdByWorkspace: {},
    lastActiveChatIdByApp: {},
  });
  return chat;
}
