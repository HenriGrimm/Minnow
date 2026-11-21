export const SELECTION_SCOPE_SELECTOR = [
  '#chatArea',
  '#chatAppArea',
  '#fileViewerHost',
  '.file-viewer-body',
  '#previewBody',
  '.board-init-split__chat',
  '.board-main',
  '[data-testid="orchestrate-chat-pane"]',
  '.mn-os-chat-transcript',
  '#settingsView',
  '#researchView',
  '#modelsView',
  '#brainView',
  '#issuesView',
  '#schedulerView',
  '#welcomeView',
  '.code-overview-root',
].join(', ');

/** True for the platform select-all chord (Ctrl+A / Cmd+A). */
export function isSelectAllShortcut(event: {
  type: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (event.type !== 'keydown') return false;
  if (event.key.toLowerCase() !== 'a') return false;
  if (event.altKey || event.shiftKey) return false;
  return event.ctrlKey || event.metaKey;
}

/** Native controls and embedded editors that already scope select-all. */
export function isDelegatedSelectAllTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const html = el as HTMLElement;
  if (html.isContentEditable) return true;
  if (el.closest('.cm-editor, .xterm, .xterm-screen')) return true;
  return false;
}

/** Nearest panel root that should own a scoped select-all. */
export function findSelectionScope(el: Element | null): HTMLElement | null {
  if (!el) return null;
  const scope = el.closest(SELECTION_SCOPE_SELECTOR);
  return scope ? (scope as HTMLElement) : null;
}

/** Select every text node inside `root` (used when the browser would select the whole app). */
export function selectAllInElement(root: HTMLElement): void {
  const selection = root.ownerDocument.defaultView?.getSelection() ?? globalThis.getSelection?.();
  if (!selection) return;
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Whether the global handler should override the default select-all behavior. */
export function shouldHandleScopedSelectAll(
  event: {
    type: string;
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  },
  activeElement: Element | null,
  lastFocusedScope: HTMLElement | null,
): boolean {
  if (!isSelectAllShortcut(event)) return false;
  if (isDelegatedSelectAllTarget(activeElement)) return false;
  return findSelectionScope(activeElement) != null || lastFocusedScope != null;
}

/** Resolve the panel that should receive select-all for this key event. */
export function resolveSelectionScopeForSelectAll(
  activeElement: Element | null,
  lastFocusedScope: HTMLElement | null,
): HTMLElement | null {
  if (isDelegatedSelectAllTarget(activeElement)) return null;
  return findSelectionScope(activeElement) ?? lastFocusedScope;
}

let lastFocusedScope: HTMLElement | null = null;
let scopedSelectAllInstalled = false;

/** Remember the last panel the user interacted with (for clicks that leave focus on body). */
export function rememberSelectionScope(scope: HTMLElement | null): void {
  lastFocusedScope = scope;
}

/** @internal Test hook — reset module state between tests. */
export function resetScopedSelectAllStateForTests(): void {
  lastFocusedScope = null;
  scopedSelectAllInstalled = false;
}

function onFocusIn(event: FocusEvent): void {
  const scope = findSelectionScope(event.target as Element | null);
  if (scope) rememberSelectionScope(scope);
}

function onPointerDown(event: Event): void {
  const scope = findSelectionScope(event.target as Element | null);
  if (scope) rememberSelectionScope(scope);
}

function onKeyDown(event: KeyboardEvent): void {
  if (!isSelectAllShortcut(event)) return;
  const active = document.activeElement;
  if (isDelegatedSelectAllTarget(active)) return;

  const scope = resolveSelectionScopeForSelectAll(active, lastFocusedScope);
  if (!scope || !scope.isConnected) return;

  event.preventDefault();
  event.stopPropagation();
  selectAllInElement(scope);
}

/** Install document listeners once (capture-phase so we beat the browser default). */
export function installScopedSelectAllHandler(): void {
  if (scopedSelectAllInstalled) return;
  scopedSelectAllInstalled = true;
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('mousedown', onPointerDown);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKeyDown, true);
}
