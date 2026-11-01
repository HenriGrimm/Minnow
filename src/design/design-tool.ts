import { createTextInput, setControlClassName } from '../ui/components';
import { createButton, setButtonClassName } from '../ui/components';
import type { AnnotationOverlay, OverlayMarker } from './overlay';
import {
  createBestElementPicker,
  createPickerTransport,
  getPreviewGuestFrame,
  uidFallbackSelector,
  type ElementPicker,
  type PickedElement,
  type PickerTransport,
} from './element-picker';
import { captureRegion, captureRegionWithOverlay } from './region-capture';
import { resolveElementSourceMapping } from './source-map';
import { addElementRefToComposer } from '../attachments/element-ref';
import { addDesignRefToComposer } from '../attachments/design-ref';
import { updateAttachmentSourceMapping } from '../attachments/store';
import { previewSourceForDesignInstance } from '../ui/preview-design-source';
import { WORKSPACE_PREVIEW_DESIGN_INSTANCE_ID } from '../ui/preview-design-mode-mount';
import { clearDesignModeNotice, setDesignModeNotice } from './design-notice';
import {
  boundingRectOfShape,
  newPinId,
  newShapeId,
  resolveShapeAnchor,
  thinPoints,
  type AnchorCandidate,
  type CommentPin,
  type DesignShape,
  type ShapeKind,
  type ShapePoint,
} from './shape-model';
import { removeDesignAttachmentsForPage } from '../attachments/store';
import {
  addPin as persistPin,
  addNoteToPin as persistNote,
  addShape as persistShape,
  clearPageAnnotations,
  erasePin as erasePinAnnotation,
  eraseShape as eraseShapeAnnotation,
  loadPageAnnotations,
  undoPage,
} from './annotation-store';

/** Shared context handed to a tool when it becomes the armed tool. */
export interface DesignToolContext {
  /** The preview instance this session is attached to (e.g. 'workspace-preview', 'design'). */
  instanceId: string;
  /** The host element the overlay/strip are mounted into (e.g. #previewBody). */
  host: HTMLElement;
  /** The mounted annotation overlay — tools draw via overlay.render()/mapGuestRect(). */
  overlay: AnnotationOverlay;
}

/** Pointer event in overlay/host-space (CSS px, origin at the host's top-left). */
export interface DesignToolPointerEvent {
  x: number;
  y: number;
  raw: PointerEvent;
}

export interface DesignTool {
  id: string;
  label: string;
  pointerMode?: 'capture' | 'passthrough';
  arm(ctx: DesignToolContext): void;
  disarm(): void;
  onPointerDown?(evt: DesignToolPointerEvent): void;
  onPointerMove?(evt: DesignToolPointerEvent): void;
  onPointerUp?(evt: DesignToolPointerEvent): void;
  render?(): void;
}

// ── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<string, DesignTool>();

/** Register (or replace) a tool by id. Last registration for a given id wins. */
export function registerDesignTool(tool: DesignTool): void {
  registry.set(tool.id, tool);
}

export function unregisterDesignTool(id: string): void {
  registry.delete(id);
}

export function getDesignTool(id: string): DesignTool | undefined {
  return registry.get(id);
}

export function listDesignTools(): DesignTool[] {
  return [...registry.values()];
}

/** Test helper — clear all registered tools between cases. */
export function resetDesignToolRegistryForTests(): void {
  registry.clear();
}

export function currentPreviewPageRef(
  designInstanceId: string = WORKSPACE_PREVIEW_DESIGN_INSTANCE_ID,
): string {
  const source = previewSourceForDesignInstance(designInstanceId);
  if (!source) return '';
  return source.kind === 'workspace' ? source.path : source.url;
}

// ── Select tool ──────────────────────────────────────────────────────────────

export function createSelectDesignTool(): SelectDesignTool {
  let ctx: DesignToolContext | null = null;
  let picker: ElementPicker | null = null;
  let transport: PickerTransport | null = null;
  let markers: OverlayMarker[] = [];

  function resetSelection(): void {
    markers = [];
    ctx?.overlay.clear();
  }

  let bindGeneration = 0;

  async function teardownPicker(): Promise<void> {
    const current = picker;
    picker = null;
    transport = null;
    if (!current) return;
    try {
      await current.disable();
    } catch {}
    current.destroy();
  }

  async function bindPicker(): Promise<void> {
    const generation = ++bindGeneration;
    if (!ctx) return;
    await teardownPicker();
    if (!ctx || generation !== bindGeneration) return;

    const armedTransport = createPickerTransport(ctx.instanceId);
    const nextPicker = createBestElementPicker({
      designInstanceId: ctx.instanceId,
      onPick: (picked) => void handlePick(picked),
      onError: (message) => {
        if (generation !== bindGeneration) return;
        const friendly = /cross-origin/i.test(message)
          ? 'Element selection is unavailable on a cross-origin preview. Use Draw or Comment to mark a region instead.'
          : `Element picker unavailable: ${message}`;
        setDesignModeNotice(ctx?.host, friendly, 'error');
      },
    });
    try {
      await nextPicker.enable();
    } catch {}
    if (!ctx || generation !== bindGeneration) {
      try {
        await nextPicker.disable();
      } catch {}
      nextPicker.destroy();
      return;
    }
    transport = armedTransport;
    picker = nextPicker;
    if (nextPicker.isEnabled()) {
      clearDesignModeNotice(ctx.host);
    }
  }

  async function handlePick(picked: PickedElement): Promise<void> {
    if (!ctx) return;
    const selector =
      picked.cssSelector || (picked.uid != null ? uidFallbackSelector(picked.uid) : '');
    if (!selector) return;

    const captured = await captureRegion({
      selector,
      boundingRect: picked.boundingRect,
      devicePixelRatio: picked.devicePixelRatio,
    });

    const attachment = addElementRefToComposer({
      selector,
      uid: picked.uid,
      pageUrl: currentPreviewPageRef(ctx.instanceId),
      tagName: picked.tagName,
      classList: picked.classList,
      outerHtmlPreview: picked.outerHTMLPreview,
      rect: picked.boundingRect,
      stylesDigest: picked.stylesDigest,
      croppedDataUrl: captured.dataUrl,
      accessibleName: picked.accessibleName,
      contrastRatio: picked.contrastRatio,
      domPath: picked.domPath,
      attributes: picked.attributes,
      computedStyles: picked.computedStyles,
    });
    if (!attachment || !ctx) return;

    const markerId = attachment.id;
    if (!markers.some((marker) => marker.id === markerId)) {
      const rect = ctx.overlay.mapGuestRect(picked.boundingRect, picked.devicePixelRatio);
      markers.push({ id: markerId, index: markers.length + 1, rect });
    }
    ctx.overlay.render(markers);
    if (captured.dataUrl) ctx.overlay.pinCaptureToMarker(markerId, captured);

    const armedTransport = transport;
    void resolveElementSourceMapping(
      {
        selector,
        pageUrl: currentPreviewPageRef(ctx.instanceId),
        tagName: picked.tagName,
        classList: picked.classList,
        outerHtmlPreview: picked.outerHTMLPreview,
      },
      armedTransport,
    ).then((mapping) => {
      updateAttachmentSourceMapping(attachment.id, mapping);
    });
  }

  return {
    id: 'select',
    label: 'Select',
    pointerMode: 'passthrough',
    clearAll() {
      resetSelection();
    },
    arm(context) {
      ctx = context;
      resetSelection();
      void bindPicker();
    },
    disarm() {
      bindGeneration += 1;
      clearDesignModeNotice(ctx?.host);
      void teardownPicker();
      resetSelection();
      ctx = null;
    },
    refreshGuestBinding() {
      void bindPicker();
    },
    render() {
      ctx?.overlay.render(markers);
    },
  };
}

const TAGGED_ELEMENTS_SCRIPT = `(() => {
  const els = Array.from(document.querySelectorAll('[data-mn-uid]'));
  return els.map((el) => {
    const uid = Number(el.getAttribute('data-mn-uid'));
    const r = el.getBoundingClientRect();
    return { uid, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });
})()`;

function getPreviewFrame(): HTMLIFrameElement | null {
  return getPreviewGuestFrame();
}

export async function gatherAnchorCandidates(
  designInstanceId: string = WORKSPACE_PREVIEW_DESIGN_INSTANCE_ID,
): Promise<AnchorCandidate[]> {
  const transport = createPickerTransport(designInstanceId);
  try {
    if (transport.mode === 'iframe') {
      const doc = getPreviewGuestFrame(designInstanceId)?.contentDocument;
      if (!doc) return [];
      return Array.from(doc.querySelectorAll('[data-mn-uid]')).map((el) => {
        const uid = Number(el.getAttribute('data-mn-uid'));
        const r = el.getBoundingClientRect();
        return {
          uid,
          selector: uidFallbackSelector(uid),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      });
    }
    const raw = await transport.eval(TAGGED_ELEMENTS_SCRIPT);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((row): row is { uid: number; rect: AnchorCandidate['rect'] } => {
        return (
          row != null &&
          typeof row === 'object' &&
          typeof (row as { uid?: unknown }).uid === 'number' &&
          (row as { rect?: unknown }).rect != null
        );
      })
      .map((row) => ({ uid: row.uid, selector: uidFallbackSelector(row.uid), rect: row.rect }));
  } catch {
    return [];
  }
}

function openInlineLabelEditor(
  host: HTMLElement,
  point: ShapePoint,
  onCommit: (text: string) => void,
): void {
  const input = createTextInput({ appearance: 'surface', type: 'text' });
  input.type = 'text';
  setControlClassName(input, 'mn-design-label-editor');
  input.placeholder = 'Label…';
  input.setAttribute('aria-label', 'Label text');
  input.style.left = `${Math.round(Math.max(0, Math.min(point.x, host.clientWidth - 160)))}px`;
  input.style.top = `${Math.round(Math.max(0, point.y - 14))}px`;

  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    input.remove();
    if (commit && text) onCommit(text);
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  host.appendChild(input);
  input.focus();
}

function guestScrollOffset(): { x: number; y: number } {
  const frame = getPreviewFrame();
  const view = frame?.contentWindow;
  if (view) {
    try {
      return { x: view.scrollX || 0, y: view.scrollY || 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  }
  return { x: window.scrollX || 0, y: window.scrollY || 0 };
}

/** Select tool factory return type — exposes marker clearing for strip "Clear all". */
export interface SelectDesignTool extends DesignTool {
  clearAll(): void;
  /** Re-bind the picker after the preview guest reloads or swaps (iframe ↔ native). */
  refreshGuestBinding(): void;
}

/** Draw tool factory return type — exposes shape-kind switching and eraser/undo for the strip. */
export interface DrawDesignTool extends DesignTool {
  setShapeKind(kind: ShapeKind): void;
  getShapeKind(): ShapeKind;
  getShapes(): DesignShape[];
  eraseShape(shapeId: string): void;
  clearAll(): void;
  undo(): void;
}

// ── Draw tool ────────────────────────────────────────────────────────────────

export function createDrawDesignTool(): DrawDesignTool {
  let ctx: DesignToolContext | null = null;
  let kind: ShapeKind = 'rect';
  let shapes: DesignShape[] = [];
  let pageKey = '';
  let dragStart: ShapePoint | null = null;
  let penPoints: ShapePoint[] = [];

  function renderShapes(): void {
    ctx?.overlay.renderShapes(shapes, (shapeId) => {
      const shape = shapes.find((s) => s.id === shapeId);
      const link = shape?.links?.[0];
      if (!link) return;
      void import('./annotation-nav').then((m) => m.jumpToChatTurn(link.chatId, link.turnId));
    });
  }

  async function finalizeShape(partial: Pick<DesignShape, 'kind' | 'points' | 'rect' | 'label'>): Promise<void> {
    const armedCtx = ctx;
    if (!armedCtx) return;
    const draft: DesignShape = {
      id: '',
      anchor: { type: 'page', x: 0, y: 0, scrollX: 0, scrollY: 0 },
      createdAt: 0,
      ...partial,
    };
    const rect = boundingRectOfShape(draft);
    const [candidates, scroll] = await Promise.all([
      gatherAnchorCandidates(),
      Promise.resolve(guestScrollOffset()),
    ]);
    if (ctx !== armedCtx) return;
    const anchor = resolveShapeAnchor(rect, candidates, {
      x: rect.x,
      y: rect.y,
      scrollX: scroll.x,
      scrollY: scroll.y,
    });
    const shape: DesignShape = { ...draft, id: newShapeId(), anchor, createdAt: Date.now() };
    shapes = [...shapes, shape];
    renderShapes();
    void persistShape(pageKey, shape);

    const svgMarkup = armedCtx.overlay.getSvgMarkup();
    const dpr = window.devicePixelRatio || 1;
    const selector = anchor.type === 'element' ? anchor.selector : `page@${Math.round(rect.x)},${Math.round(rect.y)}`;
    try {
      const captured = await captureRegionWithOverlay(
        { selector, boundingRect: rect, devicePixelRatio: dpr },
        svgMarkup,
      );
      addDesignRefToComposer({ shape, pageUrl: pageKey, compositedDataUrl: captured.dataUrl });
    } catch {
      addDesignRefToComposer({ shape, pageUrl: pageKey });
    }
  }

  return {
    id: 'draw',
    label: 'Draw',
    arm(context) {
      ctx = context;
      shapes = [];
      dragStart = null;
      penPoints = [];
      pageKey = currentPreviewPageRef(context.instanceId);
      void loadPageAnnotations(pageKey).then((data) => {
        if (ctx !== context) return;
        shapes = data.shapes;
        renderShapes();
      });
    },
    disarm() {
      ctx?.overlay.renderDraft(null);
      ctx?.overlay.renderShapes([]);
      ctx = null;
      shapes = [];
      dragStart = null;
      penPoints = [];
    },
    onPointerDown(evt) {
      dragStart = { x: evt.x, y: evt.y };
      if (kind === 'pen') penPoints = [{ x: evt.x, y: evt.y }];
    },
    onPointerMove(evt) {
      if (!dragStart || !ctx) return;
      const start = dragStart;
      const current = { x: evt.x, y: evt.y };
      const draftBase = {
        id: 'draft',
        anchor: { type: 'page', x: 0, y: 0, scrollX: 0, scrollY: 0 },
        createdAt: 0,
      } as const;

      if (kind === 'pen') {
        penPoints.push(current);
        ctx.overlay.renderDraft({ ...draftBase, kind: 'pen', points: [...penPoints] });
      } else if (kind === 'rect') {
        ctx.overlay.renderDraft({
          ...draftBase,
          kind: 'rect',
          rect: {
            x: Math.min(start.x, current.x),
            y: Math.min(start.y, current.y),
            width: Math.abs(current.x - start.x),
            height: Math.abs(current.y - start.y),
          },
        });
      } else if (kind === 'arrow') {
        ctx.overlay.renderDraft({ ...draftBase, kind: 'arrow', points: [start, current] });
      }
    },
    onPointerUp(evt) {
      if (!dragStart) return;
      const start = dragStart;
      dragStart = null;
      ctx?.overlay.renderDraft(null);
      const end = { x: evt.x, y: evt.y };

      if (kind === 'rect') {
        const rect = {
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        };
        if (rect.width < 4 && rect.height < 4) return;
        void finalizeShape({ kind: 'rect', rect });
        return;
      }

      if (kind === 'arrow') {
        if (Math.hypot(end.x - start.x, end.y - start.y) < 4) return;
        void finalizeShape({ kind: 'arrow', points: [start, end] });
        return;
      }

      if (kind === 'pen') {
        const raw = penPoints.length >= 2 ? penPoints : [start, end];
        penPoints = [];
        const thinned = thinPoints(raw);
        if (thinned.length < 2) return;
        void finalizeShape({ kind: 'pen', points: thinned });
        return;
      }

      if (kind === 'label') {
        const armedCtx = ctx;
        if (!armedCtx) return;
        openInlineLabelEditor(armedCtx.host, start, (text) => {
          if (ctx !== armedCtx) return;
          const rect = { x: start.x, y: start.y - 10, width: Math.max(24, text.length * 7 + 12), height: 20 };
          void finalizeShape({ kind: 'label', rect, label: text });
        });
      }
    },
    render() {
      renderShapes();
    },
    setShapeKind(next) {
      kind = next;
    },
    getShapeKind() {
      return kind;
    },
    getShapes() {
      return [...shapes];
    },
    eraseShape(shapeId) {
      shapes = shapes.filter((s) => s.id !== shapeId);
      renderShapes();
      void eraseShapeAnnotation(pageKey, shapeId);
    },
    clearAll() {
      shapes = [];
      dragStart = null;
      penPoints = [];
      ctx?.overlay.renderDraft(null);
      renderShapes();
    },
    undo() {
      void undoPage(pageKey).then((data) => {
        if (!data) return;
        shapes = data.shapes;
        renderShapes();
      });
    },
  };
}

/** Comment tool factory return type — exposes pin/note access for the strip's thread popover. */
export interface CommentDesignTool extends DesignTool {
  getPins(): CommentPin[];
  addNote(pinId: string, text: string): Promise<void>;
  erasePin(pinId: string): void;
  clearAll(): void;
  undo(): void;
}

// ── Comment tool ─────────────────────────────────────────────────────────────

export function createCommentDesignTool(): CommentDesignTool {
  let ctx: DesignToolContext | null = null;
  let pins: CommentPin[] = [];
  let pageKey = '';
  let popover: HTMLElement | null = null;

  function closePopover(): void {
    popover?.remove();
    popover = null;
  }

  function renderPins(): void {
    ctx?.overlay.renderPins(pins, (pinId) => {
      const pin = pins.find((p) => p.id === pinId);
      if (pin) openPopover(pin);
    });
  }

  function openPopover(pin: CommentPin): void {
    if (!ctx) return;
    closePopover();
    const host = ctx.host;
    const panel = document.createElement('div');
    panel.className = 'mn-design-pin-popover';

    const header = document.createElement('div');
    header.className = 'mn-design-pin-popover__header';

    const title = document.createElement('span');
    title.className = 'mn-design-pin-popover__title';
    title.textContent = `Comment ${pin.index}`;
    header.appendChild(title);

    const deleteBtn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
    deleteBtn.type = 'button';
    setButtonClassName(deleteBtn, 'mn-design-pin-popover__delete');
    deleteBtn.title = 'Delete pin';
    deleteBtn.setAttribute('aria-label', 'Delete pin');
    deleteBtn.textContent = '🗑';
    deleteBtn.addEventListener('click', () => erasePinInternal(pin.id));
    header.appendChild(deleteBtn);

    const closeBtn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
    closeBtn.type = 'button';
    setButtonClassName(closeBtn, 'mn-design-pin-popover__close');
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close comment thread');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => closePopover());
    header.appendChild(closeBtn);

    panel.appendChild(header);

    const list = document.createElement('div');
    list.className = 'mn-design-pin-popover__notes';
    for (const note of pin.notes) {
      const row = document.createElement('div');
      row.className = 'mn-design-pin-popover__note';
      row.textContent = note.text;
      list.appendChild(row);
    }
    panel.appendChild(list);

    const inputRow = document.createElement('div');
    inputRow.className = 'mn-design-pin-popover__input-row';

    const input = createTextInput({ appearance: 'surface', type: 'text' });
    input.type = 'text';
    setControlClassName(input, 'mn-design-pin-popover__input');
    input.placeholder = 'Add a note…';
    inputRow.appendChild(input);

    const submitNote = (): void => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      void addNoteInternal(pin.id, text);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submitNote();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        closePopover();
      }
    });

    const addBtn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
    addBtn.type = 'button';
    setButtonClassName(addBtn, 'mn-design-pin-popover__add');
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', submitNote);
    inputRow.appendChild(addBtn);

    panel.appendChild(inputRow);

    panel.style.left = `${Math.round(pin.x) + 14}px`;
    panel.style.top = `${Math.round(pin.y)}px`;
    host.appendChild(panel);
    const panelW = panel.offsetWidth || 220;
    const panelH = panel.offsetHeight || 120;
    const maxLeft = Math.max(0, host.clientWidth - panelW - 8);
    const maxTop = Math.max(0, host.clientHeight - panelH - 8);
    let left = Math.round(pin.x) + 14;
    if (left > maxLeft) left = Math.max(0, Math.round(pin.x) - panelW - 14);
    panel.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(0, Math.round(pin.y)), maxTop)}px`;

    popover = panel;
    input.focus();
  }

  function erasePinInternal(pinId: string): void {
    pins = pins.filter((p) => p.id !== pinId);
    renderPins();
    closePopover();
    void erasePinAnnotation(pageKey, pinId);
  }

  async function addNoteInternal(pinId: string, text: string): Promise<void> {
    const armedCtx = ctx;
    const data = await persistNote(pageKey, pinId, text);
    if (!data || ctx !== armedCtx) return;
    pins = data.pins;
    renderPins();
    const refreshed = pins.find((p) => p.id === pinId);
    if (refreshed) openPopover(refreshed);
  }

  return {
    id: 'comment',
    label: 'Comment',
    arm(context) {
      ctx = context;
      pins = [];
      pageKey = currentPreviewPageRef(context.instanceId);
      void loadPageAnnotations(pageKey).then((data) => {
        if (ctx !== context) return;
        pins = data.pins;
        renderPins();
      });
    },
    disarm() {
      closePopover();
      ctx?.overlay.renderPins([]);
      ctx = null;
      pins = [];
    },
    onPointerUp(evt) {
      const armedCtx = ctx;
      if (!armedCtx) return;

      const hit = pins.find((p) => Math.hypot(p.x - evt.x, p.y - evt.y) <= 14);
      if (hit) {
        openPopover(hit);
        return;
      }

      if (popover) {
        closePopover();
        return;
      }

      void (async () => {
        const rect = { x: evt.x - 1, y: evt.y - 1, width: 2, height: 2 };
        const [candidates, scroll] = await Promise.all([
          gatherAnchorCandidates(),
          Promise.resolve(guestScrollOffset()),
        ]);
        if (ctx !== armedCtx) return;
        const anchor = resolveShapeAnchor(rect, candidates, {
          x: evt.x,
          y: evt.y,
          scrollX: scroll.x,
          scrollY: scroll.y,
        });
        const pin: CommentPin = { id: newPinId(), index: pins.length + 1, x: evt.x, y: evt.y, anchor, notes: [] };
        pins = [...pins, pin];
        renderPins();
        void persistPin(pageKey, pin);
        openPopover(pin);
      })();
    },
    render() {
      renderPins();
    },
    getPins() {
      return [...pins];
    },
    async addNote(pinId, text) {
      await addNoteInternal(pinId, text);
    },
    erasePin(pinId) {
      erasePinInternal(pinId);
    },
    clearAll() {
      closePopover();
      pins = [];
      renderPins();
    },
    undo() {
      void undoPage(pageKey).then((data) => {
        if (!data) return;
        pins = data.pins;
        renderPins();
      });
    },
  };
}

function getDrawTool(): DrawDesignTool | null {
  const tool = getDesignTool('draw');
  if (tool && typeof (tool as DrawDesignTool).setShapeKind === 'function') {
    return tool as DrawDesignTool;
  }
  return null;
}

function getSelectTool(): SelectDesignTool | null {
  const tool = getDesignTool('select');
  if (tool && typeof (tool as SelectDesignTool).clearAll === 'function') {
    return tool as SelectDesignTool;
  }
  return null;
}

export async function clearAllDesignModeMarks(ctx: DesignToolContext): Promise<void> {
  const pageKey = currentPreviewPageRef(ctx.instanceId);

  getSelectTool()?.clearAll();
  getDrawTool()?.clearAll();
  const commentTool = getDesignTool('comment');
  if (commentTool && typeof (commentTool as CommentDesignTool).clearAll === 'function') {
    (commentTool as CommentDesignTool).clearAll();
  }

  if (pageKey) {
    await clearPageAnnotations(pageKey);
    removeDesignAttachmentsForPage(pageKey);
  }

  ctx.overlay.clear();
  ctx.overlay.renderShapes([]);
  ctx.overlay.renderPins([]);
  ctx.overlay.renderDraft(null);
}

// ── Placeholders ─────────────────────────────────────────────────────────────

/** Ids the built-in tool strip renders buttons for; P3/P4 implement the real behavior. */
export const BUILTIN_DESIGN_TOOL_IDS = ['select', 'draw', 'comment', 'inspect'] as const;
export type BuiltinDesignToolId = (typeof BUILTIN_DESIGN_TOOL_IDS)[number];

export interface PlaceholderDesignToolHandle {
  tool: DesignTool;
  isArmed(): boolean;
  getContext(): DesignToolContext | null;
  /** Chronological log of dispatched events, e.g. 'arm', 'down:12,34', 'disarm'. */
  getEvents(): string[];
  resetEvents(): void;
}

export function createPlaceholderDesignTool(
  id: string,
  label = id,
): PlaceholderDesignToolHandle {
  let armed = false;
  let ctx: DesignToolContext | null = null;
  const events: string[] = [];

  const tool: DesignTool = {
    id,
    label,
    arm(context) {
      armed = true;
      ctx = context;
      events.push('arm');
    },
    disarm() {
      armed = false;
      ctx = null;
      events.push('disarm');
    },
    onPointerDown(evt) {
      events.push(`down:${evt.x},${evt.y}`);
    },
    onPointerMove(evt) {
      events.push(`move:${evt.x},${evt.y}`);
    },
    onPointerUp(evt) {
      events.push(`up:${evt.x},${evt.y}`);
    },
    render() {
      events.push('render');
    },
  };

  return {
    tool,
    isArmed: () => armed,
    getContext: () => ctx,
    getEvents: () => [...events],
    resetEvents: () => {
      events.length = 0;
    },
  };
}

/** The stub tool id used by tests to exercise the registry/arm/disarm/pointer contract. */
export const STUB_DESIGN_TOOL_ID = 'stub';

export function createStubDesignTool(): PlaceholderDesignToolHandle {
  return createPlaceholderDesignTool(STUB_DESIGN_TOOL_ID, 'Stub');
}

/** Register placeholder tools for the four built-in strip buttons (idempotent). */
export function registerBuiltinPlaceholderDesignTools(): void {
  for (const id of BUILTIN_DESIGN_TOOL_IDS) {
    if (!registry.has(id)) {
      registerDesignTool(createPlaceholderDesignTool(id).tool);
    }
  }
}
