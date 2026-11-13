/** One shell overlay can sit above the routed Settings app. */
type ShellOverlay = {
  id: string;
  close: () => void;
};
let overlays: ShellOverlay[] = [];
const listeners = new Set<() => void>();
const boundDocuments = new WeakSet<Document>();

function bindDismissal(doc: Document): void {
  if (boundDocuments.has(doc)) return;
  boundDocuments.add(doc);
  const panels: Record<string, string> = {
    settings: 'settingsView', workspace: 'osWorkspaceGate', wiki: 'productWikiOverlay',
  };
  // Observe the top layer before its own outside-click handler can close it.
  doc.addEventListener('pointerdown', (event) => {
    const active = overlays.at(-1);
    if (!active || !panels[active.id]) return;
    if (active.id === 'workspace' && doc.getElementById('osWorkspaceGate')?.classList.contains('workspace-gate--opening')) return;
    const target = event.target as Element | null;
    // Dialogs, sheets and prompts layered above an open overlay belong to it.
    if (target?.closest('[data-shell-overlay], [data-above-shell-overlay]')) return;
    if (doc.getElementById(panels[active.id])?.contains(target)) return;
    closeShellOverlay();
  }, true);
  doc.addEventListener('keydown', (event) => {
    const active = overlays.at(-1);
    if (event.defaultPrevented || event.key !== 'Escape' || !active || !panels[active.id]) return;
    if (active.id === 'workspace' && (doc.getElementById('osWorkspaceGate')?.classList.contains('workspace-gate--opening')
      || (event.target as Element | null)?.closest?.('[data-above-shell-overlay]'))) return;
    const id = active.id;
    event.preventDefault();
    closeShellOverlay();
    doc.querySelector<HTMLElement>(`[data-shell-overlay="${id}"]`)?.focus();
  });
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function isShellOverlayOpen(id?: string): boolean {
  return id === undefined ? overlays.length > 0 : overlays.some((overlay) => overlay.id === id);
}

export function isShellOverlayTopmost(id: string): boolean {
  return overlays.at(-1)?.id === id;
}

export function closeShellOverlay(id = overlays.at(-1)?.id): void {
  const previous = overlays.find((overlay) => overlay.id === id);
  if (!previous) return;
  overlays = overlays.filter((overlay) => overlay !== previous);
  previous.close();
  notify();
}

/** Clear both layers before navigating away from the current surface. */
export function closeShellOverlays(): void {
  if (overlays.length === 0) return;
  const previous = overlays;
  overlays = [];
  for (const overlay of previous.reverse()) overlay.close();
  notify();
}

export function openShellOverlay(id: string, close: () => void): void {
  if (!isShellOverlayTopmost(id)) {
    if (id === 'wiki') closeShellOverlays();
    else if (!isShellOverlayTopmost('settings')) closeShellOverlay();
  }
  overlays = [...overlays.filter((overlay) => overlay.id !== id), { id, close }];
  notify();
}

export function shellOverlayClosed(id: string): void {
  if (!isShellOverlayOpen(id)) return;
  overlays = overlays.filter((overlay) => overlay.id !== id);
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
