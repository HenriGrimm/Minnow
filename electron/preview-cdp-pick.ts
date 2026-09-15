import type { WebContents } from 'electron';
import type { CdpPickedElement } from './preview-cdp-adapt.js';
import { fetchCdpNodeAsPicked, type DebuggerLike } from './preview-cdp-element-at-point.js';

export interface CdpPickSession {
  disable(): Promise<void>;
}

const HIGHLIGHT_CONFIG = {
  contentColor: { r: 158, g: 197, b: 167, a: 0.12 },
  showInfo: false,
};

const SELECTION_OUTLINE_COLOR = '#9ec5a7';

function markSelectedScript(uid: number): string {
  return `(() => {
    const el = document.querySelector('[data-mn-uid=${JSON.stringify(String(uid))}]');
    if (!el) return false;
    el.setAttribute('data-mn-selected', '');
    const accent = document.getElementById('mn-native-design-strip');
    const color = accent ? getComputedStyle(accent).color : '${SELECTION_OUTLINE_COLOR}';
    el.style.setProperty('outline', '2px solid ' + color, 'important');
    el.style.setProperty('outline-offset', '1px', 'important');
    return true;
  })()`;
}

const CLEAR_SELECTION_SCRIPT = `(() => {
  document.getElementById('mn-design-hover-outline')?.remove();
  document.querySelectorAll('[data-mn-selected]').forEach((el) => {
    el.removeAttribute('data-mn-selected');
    el.style.removeProperty('outline');
    el.style.removeProperty('outline-offset');
  });
  return true;
})()`;

interface PickDebuggerLike extends DebuggerLike {
  on(event: 'message', listener: (event: unknown, method: string, params: any) => void): unknown;
  removeListener(event: 'message', listener: (...args: unknown[]) => void): unknown;
}

// Prime the DOM tree, then re-arm inspect mode after every click.
export async function enableCdpPicking(
  wc: WebContents,
  onPick: (picked: CdpPickedElement) => void,
  onError?: (message: string) => void,
): Promise<CdpPickSession> {
  if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
    throw new Error('Preview guest is not available');
  }
  const dbg = wc.debugger as unknown as PickDebuggerLike;
  if (!dbg.isAttached()) {
    dbg.attach('1.3');
  }

  await dbg.sendCommand('DOM.enable');
  await dbg.sendCommand('CSS.enable');
  await dbg.sendCommand('Overlay.enable');
  await dbg.sendCommand('Runtime.enable');

  const requestDocument = async (): Promise<void> => {
    try {
      await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    } catch {
    }
  };
  await requestDocument();

  let disabled = false;
  const armInspectMode = async (): Promise<void> => {
    if (disabled) return;
    try {
      const colorResult = await dbg.sendCommand('Runtime.evaluate', {
        expression: `(() => { const el = document.getElementById('mn-native-design-strip'); if (!el) return null; const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.fillStyle = getComputedStyle(el).color; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3); })()`,
        returnByValue: true,
      });
      const rgb = colorResult?.result?.value;
      const color = Array.isArray(rgb) && rgb.length === 3
        ? { r: rgb[0], g: rgb[1], b: rgb[2] }
        : HIGHLIGHT_CONFIG.contentColor;
      if (disabled) return;
      await dbg.sendCommand('Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig: {
          ...HIGHLIGHT_CONFIG,
          contentColor: { ...color, a: 0.12 },
        },
      });
    } catch {
    }
  };
  await armInspectMode();

  let nextUid = 1;

  const showSelectionHighlight = async (uid: number): Promise<void> => {
    if (disabled) return;
    try {
      await dbg.sendCommand('Runtime.evaluate', { expression: markSelectedScript(uid) });
    } catch {
    }
  };

  async function handleInspectNode(backendNodeId: number): Promise<number | null> {
    try {
      // Chromium inspect mode consumes clicks, including clicks on our guest toolbar.
      const resolved = await dbg.sendCommand('DOM.resolveNode', { backendNodeId });
      const objectId = resolved?.object?.objectId;
      if (objectId) {
        try {
          const control = await dbg.sendCommand('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function() { const root = this.getRootNode(); if (root.host?.id !== 'mn-native-design-strip' && this.id !== 'mn-native-design-strip') return false; this.closest?.('[data-mn-control]')?.click(); return true; }`,
            returnByValue: true,
          });
          if (control?.result?.value === true) return null;
        } finally {
          await dbg.sendCommand('Runtime.releaseObject', { objectId });
        }
      }
      if (disabled) return null;
      const uid = nextUid;
      nextUid += 1;
      const picked = await fetchCdpNodeAsPicked(dbg, backendNodeId, uid);
      if (!picked) {
        onError?.('picked node has no box model (non-rendered element)');
        return null;
      }
      onPick(picked);
      return uid;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message);
      return null;
    }
  }

  const onInspect = async (backendNodeId: number): Promise<void> => {
    const uid = await handleInspectNode(backendNodeId);
    await armInspectMode();
    if (uid != null) await showSelectionHighlight(uid);
  };

  let hoverGeneration = 0;
  const showHoverOutline = async (nodeId: number): Promise<void> => {
    const generation = ++hoverGeneration;
    let objectId: string | undefined;
    try {
      const resolved = await dbg.sendCommand('DOM.resolveNode', { nodeId });
      objectId = resolved?.object?.objectId;
      if (!objectId || disabled || generation !== hoverGeneration) return;
      await dbg.sendCommand('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          const el = this.nodeType === 1 ? this : this.parentElement;
          let outline = document.getElementById('mn-design-hover-outline');
          if (!el || el.id === 'mn-native-design-strip' || el.getRootNode().host?.id === 'mn-native-design-strip') { outline?.remove(); return; }
          const rect = el.getBoundingClientRect();
          if (!outline) { outline = document.createElement('div'); outline.id = 'mn-design-hover-outline'; document.documentElement.appendChild(outline); }
          const toolbar = document.getElementById('mn-native-design-strip');
          const color = toolbar ? getComputedStyle(toolbar).color : '${SELECTION_OUTLINE_COLOR}';
          outline.style.cssText = 'all:initial;position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;border:2px solid ' + color + ';left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px';
        }`,
      });
    } catch {
      // Hover can race page navigation or removal of the pointed-at element.
    } finally {
      if (objectId && !wc.isDestroyed()) {
        await dbg.sendCommand('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    }
  };

  const messageHandler = (_event: unknown, method: string, params: any) => {
    if (method === 'Overlay.inspectNodeRequested' && typeof params?.backendNodeId === 'number') {
      void onInspect(params.backendNodeId);
    } else if (method === 'Overlay.nodeHighlightRequested' && typeof params?.nodeId === 'number') {
      void showHoverOutline(params.nodeId);
    } else if (method === 'DOM.documentUpdated') {
      void requestDocument();
    }
  };
  dbg.on('message', messageHandler);

  return {
    async disable(): Promise<void> {
      disabled = true;
      dbg.removeListener('message', messageHandler as (...args: unknown[]) => void);
      if (wc.isDestroyed()) return;
      try {
        await dbg.sendCommand('Overlay.setInspectMode', {
          mode: 'none',
          highlightConfig: {},
        });
        await dbg.sendCommand('Overlay.hideHighlight');
        await dbg.sendCommand('Runtime.evaluate', { expression: CLEAR_SELECTION_SCRIPT });
      } catch {
      }
      if (wc.isDestroyed()) return;
      if (dbg.isAttached()) {
        try {
          dbg.detach();
        } catch {
        }
      }
    },
  };
}
