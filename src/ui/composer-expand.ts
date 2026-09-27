import { fetchExpandedPrompt, EXPAND_FAILED_MESSAGE } from './composer-expand-client';
import { iconHtml } from './icon';
import { autoResize } from './input';
import { setStatus } from './status';

interface ExpandTarget {
  /** Button id to mount. */
  btnId: string;
  /** Existing composer button this one is inserted after. Ignored when `prebuilt`. */
  anchorIds: string[];
  /** Composer textarea this button expands. */
  inputId: string;
  /** Desktop concierge composer uses its own button chrome. */
  desktop?: boolean;
  /** Button is already in the DOM; bind in place, do not insert after a mic. */
  prebuilt?: boolean;
  /** Ghost 32px bar control (Super Plan / Research). Send stays the only accent. */
  bar?: boolean;
}

const TARGETS: readonly ExpandTarget[] = [
  { btnId: 'btnComposerExpand', anchorIds: ['btnComposerMic', 'attachBtn'], inputId: 'msgInput' },
  {
    btnId: 'btnChatAppExpand',
    anchorIds: ['btnChatAppMic', 'btnChatAppAttach'],
    inputId: 'chatAppInput',
  },
  {
    btnId: 'btnDesktopExpand',
    anchorIds: ['btnDesktopMic', 'btnDesktopAttach'],
    inputId: 'desktopInput',
    desktop: true,
  },
  {
    btnId: 'btnResearchExpand',
    anchorIds: [],
    inputId: 'researchQuery',
    prebuilt: true,
    bar: true,
  },
  {
    btnId: 'btnSuperPlanExpand',
    anchorIds: [],
    inputId: 'superPlanPrompt',
    prebuilt: true,
    bar: true,
  },
];

// ── Targets ──────────────────────────────────────────────────────────────────

/** Find an id under a possibly-disconnected tree (Super Plan builds off-document). */
function findEl(id: string, root: ParentNode = document): HTMLElement | null {
  if ('getElementById' in root && typeof root.getElementById === 'function') {
    return root.getElementById(id);
  }
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id;
  return root.querySelector(`#${escaped}`);
}

const EXPAND_MARKUP =
  iconHtml('sparkles', { className: 'composer-expand-btn__icon' }) +
  '<span class="composer-expand-btn__spinner" aria-hidden="true"></span>';

const IDLE_LABEL = 'Expand prompt';
const IDLE_TITLE = 'Expand prompt into a fuller version';
const BUSY_LABEL = 'Expanding prompt — click to cancel';
const BUSY_TITLE = 'Expanding… click to cancel';
const UNDO_LABEL = 'Undo expansion';
const UNDO_TITLE = 'Undo expansion (Ctrl+Z)';

interface ActiveRun {
  controller: AbortController;
  input: HTMLTextAreaElement;
  /** Draft captured before the first token, restored on cancel. */
  original: string;
}

let activeRun: ActiveRun | null = null;
let expandFetchImpl = fetchExpandedPrompt;
/** Bound textarea per expand button (supports off-document Super Plan trees). */
const expandInputByButton = new WeakMap<HTMLButtonElement, HTMLTextAreaElement>();
/** Undo button mounted beside each expand button, keyed by its textarea. */
const undoButtonByInput = new WeakMap<HTMLTextAreaElement, HTMLButtonElement>();

interface UndoRecord {
  original: string;
  expanded: string;
}

/** Last settled expansion per textarea; undoable while the text still matches. */
const undoByInput = new WeakMap<HTMLTextAreaElement, UndoRecord>();

/** Replace the expansion request (unit tests). */
export function setExpandPromptFetcherForTests(
  impl: typeof fetchExpandedPrompt | null,
): void {
  expandFetchImpl = impl ?? fetchExpandedPrompt;
}

function findTargetByButtonId(btnId: string): ExpandTarget | undefined {
  return TARGETS.find((t) => t.btnId === btnId);
}

function resolveInput(
  target: ExpandTarget,
  root: ParentNode = document,
): HTMLTextAreaElement | null {
  const node = findEl(target.inputId, root);
  return node?.tagName === 'TEXTAREA' ? (node as HTMLTextAreaElement) : null;
}

function resizeComposerInput(input: HTMLTextAreaElement): void {
  autoResize(input);
}

// ── Apply ────────────────────────────────────────────────────────────────────

/** Write text into the composer. */
function applyToComposer(
  input: HTMLTextAreaElement,
  text: string,
  { notify = true }: { notify?: boolean } = {},
): void {
  input.value = text;
  if (notify) input.dispatchEvent(new Event('input', { bubbles: true }));
  resizeComposerInput(input);
}

function setButtonBusy(btn: HTMLButtonElement, busy: boolean): void {
  btn.classList.toggle('composer-expand-btn--busy', busy);
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  btn.setAttribute('aria-label', busy ? BUSY_LABEL : IDLE_LABEL);
  btn.title = busy ? BUSY_TITLE : IDLE_TITLE;
}

/** Disable when there is nothing to expand; never fight the busy state. */
function syncButtonEnabled(btn: HTMLButtonElement, input: HTMLTextAreaElement | null): void {
  if (btn.classList.contains('composer-expand-btn--busy')) return;
  btn.disabled = !input || input.value.trim().length === 0;
}

function syncAllButtons(): void {
  for (const target of TARGETS) {
    const btn = document.getElementById(target.btnId) as HTMLButtonElement | null;
    if (btn) syncButtonEnabled(btn, resolveInput(target));
  }
}

/** Cancel an in-flight expansion and put the original draft back. */
export function cancelComposerExpand(): boolean {
  const run = activeRun;
  if (!run) return false;
  run.controller.abort();
  applyToComposer(run.input, run.original);
  return true;
}

/** Cancel only if the active expansion belongs to this textarea. */
export function cancelComposerExpandFor(inputId: string): boolean {
  if (activeRun?.input.id !== inputId) return false;
  return cancelComposerExpand();
}

// ── Undo ─────────────────────────────────────────────────────────────────────

function findValueDescriptor(input: HTMLTextAreaElement): PropertyDescriptor | undefined {
  for (let proto = Object.getPrototypeOf(input); proto; proto = Object.getPrototypeOf(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.get && desc.set) return desc;
  }
  return undefined;
}

/**
 * Send, chat switches and draft restores assign `value` without an input event.
 * While an undo is armed, shadow the setter so any such write disarms it —
 * otherwise the undo button would linger over a composer it no longer describes.
 */
function watchProgrammaticWrites(input: HTMLTextAreaElement): void {
  if (Object.prototype.hasOwnProperty.call(input, 'value')) return;
  const desc = findValueDescriptor(input);
  if (!desc) return;
  const { get, set } = desc as { get: () => string; set: (v: string) => void };
  Object.defineProperty(input, 'value', {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      return get.call(this);
    },
    set(next: string) {
      set.call(this, next);
      disarmUndo(input);
    },
  });
}

function syncUndoButton(input: HTMLTextAreaElement): void {
  const btn = undoButtonByInput.get(input);
  if (!btn) return;
  const record = undoByInput.get(input);
  btn.hidden = !record || input.value !== record.expanded;
}

function armUndo(input: HTMLTextAreaElement, original: string, expanded: string): void {
  undoByInput.set(input, { original, expanded });
  watchProgrammaticWrites(input);
  syncUndoButton(input);
}

function disarmUndo(input: HTMLTextAreaElement): void {
  undoByInput.delete(input);
  // Drop the instance shadow so the prototype accessor is back in charge.
  if (Object.prototype.hasOwnProperty.call(input, 'value')) {
    delete (input as { value?: string }).value;
  }
  syncUndoButton(input);
}

/** Put the pre-expansion draft back. False when there is nothing to undo. */
function undoExpansion(input: HTMLTextAreaElement): boolean {
  const record = undoByInput.get(input);
  if (!record || activeRun || input.value !== record.expanded) return false;
  disarmUndo(input);
  applyToComposer(input, record.original);
  const end = input.value.length;
  input.setSelectionRange(end, end);
  input.focus();
  setStatus('ok', 'Expansion undone');
  return true;
}

/** Undo the last expansion of this textarea, if it is still showing. */
export function undoComposerExpandFor(inputId: string, root: ParentNode = document): boolean {
  const node = findEl(inputId, root);
  return node?.tagName === 'TEXTAREA' ? undoExpansion(node as HTMLTextAreaElement) : false;
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function runExpand(btn: HTMLButtonElement, target: ExpandTarget): Promise<void> {
  const input = expandInputByButton.get(btn) ?? resolveInput(target);
  const original = input?.value ?? '';
  if (!input || !original.trim()) return;

  disarmUndo(input);
  const controller = new AbortController();
  activeRun = { controller, input, original };
  setButtonBusy(btn, true);
  input.classList.add('composer-expanding');
  input.readOnly = true;
  setStatus('spin', 'Expanding prompt…');

  try {
    const result = await expandFetchImpl({
      draft: original,
      signal: controller.signal,
      onPartial: (text) => {
        if (controller.signal.aborted) return;
        applyToComposer(input, text, { notify: false });
      },
    });

    if (controller.signal.aborted) {
      setStatus('ok', 'Expand cancelled');
      return;
    }
    if (result.error) {
      applyToComposer(input, original);
      setStatus('err', result.error);
      return;
    }
    if (!result.text) {
      applyToComposer(input, original);
      setStatus('ok', 'Composer ready');
      return;
    }

    applyToComposer(input, result.text);
    if (result.text !== original) armUndo(input, original, result.text);
    setStatus('ok', 'Prompt expanded');
  } catch (err) {
    applyToComposer(input, original);
    setStatus('err', err instanceof Error ? err.message : EXPAND_FAILED_MESSAGE);
  } finally {
    activeRun = null;
    input.readOnly = false;
    input.classList.remove('composer-expanding');
    setButtonBusy(btn, false);
    syncAllButtons();
    const end = input.value.length;
    input.setSelectionRange(end, end);
    input.focus();
  }
}

function onExpandClick(event: Event): void {
  const btn = event.currentTarget as HTMLButtonElement;
  if (activeRun) {
    cancelComposerExpand();
    return;
  }
  const target = findTargetByButtonId(btn.id);
  if (!target) return;
  void runExpand(btn, target);
}

function isUndoChord(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'z'
  );
}

/**
 * Escape aborts a running expansion; Ctrl/Cmd+Z reverts a settled one. Assigning
 * `value` wipes the textarea's native undo stack, so without this the draft is gone.
 */
function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && activeRun) {
    if (cancelComposerExpand()) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if (isUndoChord(event) && undoExpansion(event.currentTarget as HTMLTextAreaElement)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

/**
 * Clearing the composer ends the expansion's life; edits only hide the button,
 * so native-undoing back to the expanded text makes it undoable again.
 */
function onComposerInput(input: HTMLTextAreaElement): void {
  if (!input.value) disarmUndo(input);
  else syncUndoButton(input);
}

function bindInput(
  target: ExpandTarget,
  btn: HTMLButtonElement,
  root: ParentNode = document,
): void {
  const input = resolveInput(target, root);
  if (!input) return;
  expandInputByButton.set(btn, input);
  if (!input.dataset.expandBound) {
    input.addEventListener('input', () => {
      syncButtonEnabled(btn, input);
      onComposerInput(input);
    });
    input.addEventListener('keydown', onComposerKeydown);
    input.dataset.expandBound = '1';
  }
  syncButtonEnabled(btn, input);
}

function bindExpandButton(
  target: ExpandTarget,
  btn: HTMLButtonElement,
  root: ParentNode = document,
): void {
  if (!btn.innerHTML.trim()) btn.innerHTML = EXPAND_MARKUP;
  if (!btn.hasAttribute('aria-label')) btn.setAttribute('aria-label', IDLE_LABEL);
  if (!btn.hasAttribute('aria-busy')) btn.setAttribute('aria-busy', 'false');
  if (!btn.title) btn.title = IDLE_TITLE;
  if (!btn.dataset.expandClickBound) {
    btn.dataset.expandClickBound = '1';
    btn.addEventListener('click', onExpandClick);
  }
  bindInput(target, btn, root);
  ensureUndoButton(target, btn);
}

function undoButtonClass(target: ExpandTarget): string {
  const chrome = target.bar
    ? 'composer-expand-btn--bar'
    : target.desktop
      ? 'mn-os-desktop-comp-btn'
      : 'input-inset-btn';
  return `${chrome} composer-expand-undo-btn`;
}

/** Mount the undo control right after the expand button; hidden until an expansion lands. */
function ensureUndoButton(target: ExpandTarget, expandBtn: HTMLButtonElement): void {
  const input = expandInputByButton.get(expandBtn);
  if (!input || !expandBtn.parentElement) return;
  const next = expandBtn.nextElementSibling;
  let undo =
    next?.tagName === 'BUTTON' && next.classList.contains('composer-expand-undo-btn')
      ? (next as HTMLButtonElement)
      : null;
  if (!undo) {
    undo = document.createElement('button');
    undo.type = 'button';
    undo.className = undoButtonClass(target);
    undo.setAttribute('aria-label', UNDO_LABEL);
    undo.title = UNDO_TITLE;
    undo.innerHTML = iconHtml('undo', { className: 'composer-expand-btn__icon' });
    undo.hidden = true;
    undo.addEventListener('click', () => undoExpansion(input));
    expandBtn.insertAdjacentElement('afterend', undo);
  }
  undoButtonByInput.set(input, undo);
  syncUndoButton(input);
}

function ensureExpandButton(target: ExpandTarget, root: ParentNode = document): void {
  const existing = findEl(target.btnId, root);
  if (existing?.tagName === 'BUTTON') {
    bindExpandButton(target, existing as HTMLButtonElement, root);
    return;
  }
  if (target.prebuilt) return;

  const anchor = target.anchorIds
    .map((id) => findEl(id, root))
    .find((el): el is HTMLElement => Boolean(el));
  if (!anchor?.parentElement) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = target.btnId;
  btn.className = target.bar
    ? 'composer-expand-btn composer-expand-btn--bar'
    : target.desktop
      ? 'mn-os-desktop-comp-btn composer-expand-btn'
      : 'input-inset-btn composer-expand-btn';
  btn.setAttribute('aria-label', IDLE_LABEL);
  btn.setAttribute('aria-busy', 'false');
  btn.title = IDLE_TITLE;
  btn.innerHTML = EXPAND_MARKUP;
  btn.disabled = true;
  // Insert first so the undo control can mount as the next sibling.
  anchor.insertAdjacentElement('afterend', btn);
  bindExpandButton(target, btn, root);
}

// ── Init ─────────────────────────────────────────────────────────────────────

/** Mount Expand buttons. Pass a search root for disconnected Super Plan trees. */
export function initComposerExpand(root: ParentNode = document): void {
  for (const target of TARGETS) {
    ensureExpandButton(target, root);
  }
}

/** True while an expansion is streaming (tests / send-path guards). */
export function isComposerExpanding(): boolean {
  return activeRun !== null;
}
