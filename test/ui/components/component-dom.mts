/**
 * happy-dom environment for component suites. Installs the globals the
 * components read (document, window, HTMLElement, Node) and restores them.
 */

import { Window } from 'happy-dom';

const GLOBALS = ['document', 'window', 'HTMLElement', 'Node'] as const;

export interface ComponentDom {
  win: Window;
  doc: Document;
  key(target: EventTarget, key: string, init?: KeyboardEventInit): KeyboardEvent;
  pointer(target: EventTarget, type: string, init?: PointerEventInit): PointerEvent;
  cleanup(): void;
}

export function installComponentDom(): ComponentDom {
  const win = new Window({ width: 1024, height: 768 });
  const g = globalThis as Record<string, unknown>;
  const saved = new Map(GLOBALS.map((name) => [name, g[name]]));
  g.window = win;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;

  return {
    win,
    doc: win.document as unknown as Document,
    key(target, key, init = {}) {
      const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event as unknown as Event);
      return event as unknown as KeyboardEvent;
    },
    pointer(target, type, init = {}) {
      const event = new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', ...init });
      target.dispatchEvent(event as unknown as Event);
      return event as unknown as PointerEvent;
    },
    cleanup() {
      void win.happyDOM.abort();
      win.close();
      for (const [name, value] of saved) {
        if (value === undefined) delete g[name];
        else g[name] = value;
      }
    },
  };
}
