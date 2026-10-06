export type PluginMountPosition = 'append' | 'prepend' | 'before' | 'after';
export type PluginDomRender = (target: HTMLElement) => HTMLElement | { element: HTMLElement; dispose?: () => void };

interface Mount {
  selector: string;
  render: PluginDomRender;
  position: PluginMountPosition;
  nodes: Map<HTMLElement, { element: HTMLElement; dispose?: () => void }>;
}

const mounts = new Set<Mount>();
let observer: MutationObserver | null = null;
let scheduled = false;

function removeNode(node: { element: HTMLElement; dispose?: () => void }): void {
  try { node.dispose?.(); } catch (error) { console.error('[plugin-ui] DOM cleanup failed', error); }
  node.element.remove();
}

function refresh(mount: Mount): void {
  const targets = new Set(document.querySelectorAll<HTMLElement>(mount.selector));
  for (const [target, node] of mount.nodes) {
    const parent = mount.position === 'before' || mount.position === 'after' ? target.parentElement : target;
    if (targets.has(target) && node.element.isConnected && node.element.parentElement === parent) continue;
    removeNode(node);
    mount.nodes.delete(target);
  }
  for (const target of targets) {
    if (mount.nodes.has(target)) continue;
    try {
      const rendered = mount.render(target);
      const node = rendered instanceof HTMLElement ? { element: rendered } : rendered;
      if (!(node.element instanceof HTMLElement) || node.element.isConnected || node.element === target || node.element.contains(target)) {
        node.dispose?.();
        throw new Error('Mount must return a new detached element');
      }
      mount.nodes.set(target, node);
      if (mount.position === 'before') target.before(node.element);
      else if (mount.position === 'after') target.after(node.element);
      else if (mount.position === 'prepend') target.prepend(node.element);
      else target.append(node.element);
    } catch (error) { console.error('[plugin-ui] DOM mount failed', error); }
  }
}

/** Keep owned elements attached when a core surface is lazily mounted or rebuilt. */
export function mountPluginDom(selector: string, render: PluginDomRender, position: PluginMountPosition = 'append'): () => void {
  if (!['append', 'prepend', 'before', 'after'].includes(position)) throw new Error('Invalid mount position');
  document.querySelector(selector); // Validate before registering an observer.
  const mount: Mount = { selector, render, position, nodes: new Map() };
  mounts.add(mount);
  if (!observer) {
    observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        for (const entry of mounts) refresh(entry);
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  refresh(mount);
  return () => {
    mounts.delete(mount);
    for (const node of mount.nodes.values()) removeNode(node);
    mount.nodes.clear();
    if (mounts.size === 0) { observer?.disconnect(); observer = null; }
  };
}
