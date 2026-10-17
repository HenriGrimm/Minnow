/** Exclusive shell overlays. Lifecycle owners report opens/closes, not click guesses. */
type ShellOverlay = {
  id: string;
  close: () => void;
};
let active: ShellOverlay | null = null;
const listeners = new Set<() => void>();
const boundDocuments = new WeakSet<Document>();

function bindDismissal(doc: Document): void {
  if (boundDocuments.has(doc)) return;
  boundDocuments.add(doc);
  const panels: Record<string, string> = {
    settings: 'settingsView', workspace: 'osWorkspaceGate', wiki: 'productWikiOverlay',
  };
  doc.addEventListener('pointerdown', (event) => {
    if (!active || !panels[active.id]) return;
    const target = event.target as Element | null;
    if (target?.closest('[data-shell-overlay]')) return;
    if (doc.getElementById(panels[active.id])?.contains(target)) return;
    closeShellOverlay();
  });
  doc.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.key !== 'Escape' || !active || !panels[active.id]) return;
    const id = active.id;
    event.preventDefault();
    closeShellOverlay();
    doc.querySelector<HTMLElement>(`[data-shell-overlay="${id}"]`)?.focus();
  });
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function isShellOverlayOpen(id: string): boolean {
  return active?.id === id;
}

/** Close before opening the next surface so route-based return targets stay valid. */
export function closeShellOverlay(): void {
  const previous = active;
  if (!previous) return;
  active = null;
  previous.close();
  notify();
}

export function openShellOverlay(id: string, close: () => void): void {
  if (active?.id !== id) closeShellOverlay();
  active = { id, close };
  notify();
}

export function shellOverlayClosed(id: string): void {
  if (active?.id !== id) return;
  active = null;
  notify();
}

/** Multiple nav controls may represent the same surface (e.g. Settings rail + header). */
export function bindShellOverlayTrigger(button: HTMLElement, id: string): () => void {
  button.dataset.shellOverlay = id;
  bindDismissal(button.ownerDocument);
  const sync = () => {
    const open = isShellOverlayOpen(id);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-pressed', String(open));
    button.classList.toggle('is-overlay-open', open);
  };
  listeners.add(sync);
  sync();
  return () => listeners.delete(sync);
}
