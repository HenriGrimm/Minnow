/**
 * Assistant markdown rendering: marked → DOMPurify → highlight.js.
 *
 * Streaming reuses prefix DOM: only dirty trailing tokens are parsed, sanitized,
 * highlighted and decorated. Lexing still examines the full Markdown string.
 * Non-streaming callers keep a one-shot
 * marked.parse + innerHTML fast path.
 */

import DOMPurify from 'dompurify';
import { marked, type Token } from 'marked';
import { highlightCodeElement } from './highlighter';
import { applyMarkdownHeadingIds, decorateRenderedMarkdown, hardenMarkdownAnchors, initMarkdownLinkRouting } from './links';
import { ASSISTANT_RENDER_DEBOUNCE_MS } from '../constants';
import {
  assistantRenderDebounceTimer,
  setAssistantRenderDebounceTimer,
} from '../app-state';
import { announceStreamingProse } from '../ui/a11y/stream-announcer';
import { scrollBottom } from '../ui/input';

// ── State ────────────────────────────────────────────────────────────────────

let minnowMarkedConfigured = false;

/** Per-bubble incremental render state (WeakMap so detached bubbles GC cleanly). */
interface RenderState {
  /** FNV-1a of each committed token's `raw` — hashes, not raw, to avoid O(n) memory. */
  signatures: number[];
  /** DOM nodes produced per token (space tokens may yield zero nodes). */
  nodes: Node[][];
  /** Heading slugs per token, so replacing a suffix can roll back only its counts. */
  headingBases: string[][];
  headingCounts: Map<string, number>;
  /** Trailing flush for the remaining throttle window (not reset on every chunk). */
  timer: ReturnType<typeof setTimeout> | null;
  /** Guarantees a paint during continuous fast streams (mirrors file-tree max-delay). */
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
  /** Latest markdown/cursor to paint on the next flush. */
  pendingMarkdown: string | null;
  pendingCursor: HTMLElement | null;
  /** Wall time of the last scheduled paint (`0` = never painted via scheduler). */
  lastRenderedAt: number;
}

const renderStateByBubble = new WeakMap<HTMLElement, RenderState>();
/** Strong refs for bubbles with an active debounce timer (cancel-all needs iteration). */
const bubblesWithActiveTimer = new Set<HTMLElement>();

/**
 * Live streaming caret class. CSS matches this token only so model HTML with a
 * generic `cursor` class cannot keep blinking after the reply settles.
 */
export const STREAMING_CARET_CLASS = 'cursor--prose';
export const STREAMING_CARET_SELECTOR = '.cursor--prose';

/** Drop leftover streaming carets under `root`, optionally keeping one live node. */
export function removeStreamingCarets(root: ParentNode, keep?: HTMLElement | null): void {
  for (const el of [...root.querySelectorAll(STREAMING_CARET_SELECTOR)]) {
    if (keep && el === keep) continue;
    el.remove();
  }
}

function clearPendingPaint(state: RenderState): void {
  state.pendingMarkdown = null;
  state.pendingCursor = null;
}

function getRenderState(bubble: HTMLElement): RenderState {
  let state = renderStateByBubble.get(bubble);
  if (!state) {
    state = {
      signatures: [],
      nodes: [],
      headingBases: [],
      headingCounts: new Map(),
      timer: null,
      maxWaitTimer: null,
      pendingMarkdown: null,
      pendingCursor: null,
      lastRenderedAt: 0,
    };
    renderStateByBubble.set(bubble, state);
  }
  return state;
}

/** FNV-1a 32-bit — cheap stable hash of token.raw for dirty detection. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function clearBubbleTimers(bubble: HTMLElement, state: RenderState): void {
  if (state.timer != null) {
    if (assistantRenderDebounceTimer === state.timer) {
      setAssistantRenderDebounceTimer(null);
    }
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.maxWaitTimer != null) {
    clearTimeout(state.maxWaitTimer);
    state.maxWaitTimer = null;
  }
  bubblesWithActiveTimer.delete(bubble);
}

/**
 * Cancel debounced streaming renders.
 * Pass a bubble to cancel only that bubble; omit to cancel every active timer
 * (existing chat.ts / loop.ts call sites).
 */
export function cancelAssistantBubbleRenderDebounce(bubble?: HTMLElement): void {
  if (bubble) {
    const state = renderStateByBubble.get(bubble);
    if (state) {
      clearBubbleTimers(bubble, state);
      clearPendingPaint(state);
    }
    return;
  }
  if (assistantRenderDebounceTimer != null) {
    clearTimeout(assistantRenderDebounceTimer);
    setAssistantRenderDebounceTimer(null);
  }
  for (const b of [...bubblesWithActiveTimer]) {
    const state = renderStateByBubble.get(b);
    if (state) {
      clearBubbleTimers(b, state);
      clearPendingPaint(state);
    }
  }
}

/** Stop pending paints and strip every streaming caret from a finished bubble. */
export function finishStreamingBubbleRender(
  bubble: HTMLElement,
  cursor?: HTMLElement | null,
): void {
  cancelAssistantBubbleRenderDebounce(bubble);
  cursor?.remove();
  removeStreamingCarets(bubble);
  const wrap = bubble.parentElement;
  if (wrap) removeStreamingCarets(wrap);
}

/** Configure marked once for GitHub-flavored markdown without single-line breaks. */
function ensureMarkedOptionsConfigured(): void {
  if (minnowMarkedConfigured) return;
  minnowMarkedConfigured = true;
  try {
    if (typeof marked.use === 'function') {
      marked.use({ gfm: true, breaks: false });
      return;
    }
    if (typeof (marked as { setOptions?: (o: object) => void }).setOptions === 'function') {
      (marked as { setOptions: (o: object) => void }).setOptions({ gfm: true, breaks: false });
    }
  } catch {}
}

export interface AssistantBubbleOptions {
  streaming?: boolean;
  streamCursor?: HTMLElement | null;
  modeId?: string;
}

/** Apply data-lang attributes on `<pre>` from fenced code class names. */
function applyDataLangAttributes(root: ParentNode): void {
  root.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    if (!code) return;
    const m = /\blanguage-([\w-]+)\b/.exec(code.className || '');
    if (m) pre.setAttribute('data-lang', m[1]);
    else pre.removeAttribute('data-lang');
  });
}

/** Highlight code blocks under root; optionally skip the last unfinished fence. */
function highlightCodeBlocks(
  root: ParentNode,
  options: { skipUnterminatedFinalFence?: boolean; finalToken?: Token | null } = {},
): void {
  const { skipUnterminatedFinalFence = false, finalToken = null } = options;
  const skipFinal =
    skipUnterminatedFinalFence &&
    finalToken != null &&
    finalToken.type === 'code' &&
    !/```\s*$/.test(finalToken.raw ?? '');

  const blocks = root.querySelectorAll('pre code');
  blocks.forEach((block, index) => {
    if (skipFinal && index === blocks.length - 1) return;
    if (!block.classList.contains('hljs')) {
      void highlightCodeElement(block as HTMLElement);
    }
  });
}

/** Reset incremental bookkeeping after a destructive full replace. */
function resetIncrementalState(bubble: HTMLElement): void {
  const state = getRenderState(bubble);
  state.signatures = [];
  state.nodes = [];
  state.headingBases = [];
  state.headingCounts.clear();
}

// ── Incremental ──────────────────────────────────────────────────────────────

/** One-shot full render (non-streaming / final flush) — same cost as the pre-Phase-5 path. */
function renderFull(
  bubble: HTMLElement,
  raw: string,
  streaming: boolean,
  streamCursor: HTMLElement | null,
): void {
  ensureMarkedOptionsConfigured();

  let html: string;
  try {
    html = marked.parse(raw) as string;
  } catch {
    bubble.textContent = raw;
    if (streaming && streamCursor) bubble.appendChild(streamCursor);
    resetIncrementalState(bubble);
    return;
  }

  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  bubble.innerHTML = clean;
  applyDataLangAttributes(bubble);
  highlightCodeBlocks(bubble);
  decorateRenderedMarkdown(bubble);

  if (streaming && streamCursor) {
    removeStreamingCarets(bubble);
    bubble.appendChild(streamCursor);
  } else {
    removeStreamingCarets(bubble);
  }
  resetIncrementalState(bubble);
}

/**
 * Incremental streaming render: lex whole string, reuse unchanged prefix DOM,
 * re-parse only from the first dirty token (always including the growing last block).
 */
function renderIncremental(
  bubble: HTMLElement,
  raw: string,
  streamCursor: HTMLElement | null,
): void {
  ensureMarkedOptionsConfigured();
  const state = getRenderState(bubble);

  let tokens: Token[];
  try {
    tokens = marked.lexer(raw) as Token[];
  } catch {
    renderFull(bubble, raw, true, streamCursor);
    return;
  }

  let dirtyFrom = 0;
  const limit = Math.min(tokens.length, state.signatures.length);
  while (dirtyFrom < limit) {
    if (fnv1a32(tokens[dirtyFrom]!.raw ?? '') !== state.signatures[dirtyFrom]) break;
    dirtyFrom += 1;
  }
  if (tokens.length === 0) {
    dirtyFrom = 0;
  } else {
    dirtyFrom = Math.min(dirtyFrom, tokens.length - 1);
  }

  for (let i = dirtyFrom; i < state.nodes.length; i++) {
    for (const base of state.headingBases[i] ?? []) {
      const count = (state.headingCounts.get(base) ?? 1) - 1;
      if (count === 0) state.headingCounts.delete(base);
      else state.headingCounts.set(base, count);
    }
    for (const node of state.nodes[i] ?? []) {
      node.parentNode?.removeChild(node);
    }
  }
  state.nodes.length = dirtyFrom;
  state.signatures.length = dirtyFrom;
  state.headingBases.length = dirtyFrom;

  if (streamCursor?.parentNode) streamCursor.remove();
  removeStreamingCarets(bubble);

  const fragment = document.createDocumentFragment();
  const newNodeGroups: Node[][] = [];

  for (let i = dirtyFrom; i < tokens.length; i++) {
    const token = tokens[i]!;
    let html: string;
    try {
      html = marked.parser([token]) as string;
    } catch {
      html = '';
    }
    const wrapped = html.trim() ? `<div data-mn-md-wrap>${html}</div>` : '';
    const cleanWrapped = DOMPurify.sanitize(wrapped, { USE_PROFILES: { html: true } });
    const template = document.createElement('template');
    template.innerHTML = cleanWrapped;
    const wrapEl = template.content.querySelector('[data-mn-md-wrap]');
    const sourceRoot: ParentNode = wrapEl ?? template.content;
    state.headingBases.push(applyMarkdownHeadingIds(sourceRoot, state.headingCounts));
    hardenMarkdownAnchors(sourceRoot);
    const children = Array.from(sourceRoot.childNodes).filter((n) => {
      if (n.nodeType === 1) return true;
      if (n.nodeType === 3) return (n.textContent ?? '').length > 0;
      return false;
    });
    for (const child of children) {
      fragment.appendChild(child);
    }
    newNodeGroups.push(children);
    state.signatures.push(fnv1a32(token.raw ?? ''));
  }

  applyDataLangAttributes(fragment);
  highlightCodeBlocks(fragment, {
    skipUnterminatedFinalFence: true,
    finalToken: tokens[tokens.length - 1] ?? null,
  });

  bubble.appendChild(fragment);
  for (const group of newNodeGroups) {
    state.nodes.push(group);
  }

  initMarkdownLinkRouting();

  if (streamCursor) bubble.appendChild(streamCursor);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render assistant markdown: marked → DOMPurify → highlight.js.
 * When streaming, re-appends the live cursor after updates and uses incremental DOM.
 */
export function setAssistantBubbleContent(
  bubble: HTMLElement,
  markdown: string | null | undefined,
  options: AssistantBubbleOptions = {},
): void {
  const streaming = options.streaming === true;
  const streamCursor = options.streamCursor || null;

  bubble.classList.add('msg-bubble--md');

  const raw = markdown == null ? '' : String(markdown);

  if (!raw.trim() && streaming && streamCursor) {
    bubble.textContent = '';
    bubble.appendChild(streamCursor);
    resetIncrementalState(bubble);
    return;
  }

  if (!raw.trim() && !streaming) {
    bubble.innerHTML = '';
    removeStreamingCarets(bubble);
    resetIncrementalState(bubble);
    return;
  }

  if (streaming) {
    renderIncremental(bubble, raw, streamCursor);
    return;
  }

  renderFull(bubble, raw, false, null);
}

/** Options for a streaming markdown flush. */
export interface AssistantBubbleRenderOptions {
  /**
   * When false, skip `scrollBottom` on this flush. The chat painter (MIN-729)
   * owns stream follow-scroll so one rAF tick is not two forced layouts.
   * Debounce-timer flushes keep the default (true) so a paused stream still pins.
   */
  pinScroll?: boolean;
  /**
   * Paint now even inside the debounce window. Tool-start / tool-call flushes
   * use this so a pending full sentence is not hidden under "Calling…".
   */
  immediate?: boolean;
}

/** Paint the latest pending markdown for a streaming assistant bubble. */
export function flushAssistantBubbleRender(
  bubble: HTMLElement,
  opts?: AssistantBubbleRenderOptions,
): void {
  const state = renderStateByBubble.get(bubble);
  if (!state || state.pendingMarkdown == null || state.pendingCursor == null) {
    return;
  }

  clearBubbleTimers(bubble, state);

  const { pendingMarkdown, pendingCursor } = state;
  setAssistantBubbleContent(bubble, pendingMarkdown, {
    streaming: true,
    streamCursor: pendingCursor,
  });
  announceStreamingProse(pendingMarkdown);
  if (opts?.pinScroll !== false) {
    scrollBottom();
  }
  state.lastRenderedAt = Date.now();
}

/**
 * Throttled markdown refresh while the assistant reply is still streaming.
 * Paints immediately on first token and at most every ASSISTANT_RENDER_DEBOUNCE_MS;
 * a max-wait timer guarantees paints during continuous fast SSE delivery.
 */
export function scheduleAssistantBubbleRender(
  bubble: HTMLElement,
  markdown: string,
  streamCursor: HTMLElement,
  opts?: AssistantBubbleRenderOptions,
): void {
  const state = getRenderState(bubble);
  state.pendingMarkdown = markdown;
  state.pendingCursor = streamCursor;

  if (opts?.immediate) {
    flushAssistantBubbleRender(bubble, opts);
    return;
  }

  const now = Date.now();
  const neverRendered = state.lastRenderedAt === 0;
  const throttleElapsed = now - state.lastRenderedAt >= ASSISTANT_RENDER_DEBOUNCE_MS;

  if (neverRendered || throttleElapsed) {
    flushAssistantBubbleRender(bubble, opts);
    return;
  }

  if (state.timer == null) {
    const remaining = ASSISTANT_RENDER_DEBOUNCE_MS - (now - state.lastRenderedAt);
    const timer = setTimeout(() => {
      flushAssistantBubbleRender(bubble);
    }, remaining);
    state.timer = timer;
    bubblesWithActiveTimer.add(bubble);
    setAssistantRenderDebounceTimer(timer);
  }

  if (state.maxWaitTimer == null) {
    state.maxWaitTimer = setTimeout(() => {
      flushAssistantBubbleRender(bubble);
    }, ASSISTANT_RENDER_DEBOUNCE_MS);
  }
}

/** Test helper — read incremental state for a bubble. */
export function getAssistantBubbleRenderStateForTests(bubble: HTMLElement): {
  signatureCount: number;
  nodeGroupCount: number;
  firstNode: Node | null;
  lastRenderedAt: number;
} {
  const state = renderStateByBubble.get(bubble);
  return {
    signatureCount: state?.signatures.length ?? 0,
    nodeGroupCount: state?.nodes.length ?? 0,
    firstNode: state?.nodes[0]?.[0] ?? null,
    lastRenderedAt: state?.lastRenderedAt ?? 0,
  };
}
