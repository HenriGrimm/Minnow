const loadUnloadValueResolvers = new WeakMap<HTMLElement, () => string>();

/** Register how a host filter bar resolves the model key for load/unload actions. */
export function setModelHostFilterLoadUnloadResolver(
  bar: HTMLElement,
  resolve: () => string,
): void {
  loadUnloadValueResolvers.set(bar, resolve);
}

/** Register how a menu action row resolves the model its Load / Open settings actions target. */
export function setModelMenuActionResolver(
  el: HTMLElement,
  resolve: () => string,
): void {
  loadUnloadValueResolvers.set(el, resolve);
}

/** Resolve the select value for load/unload on a filter bar (falls back to #modelSelect). */
export function resolveModelHostFilterLoadUnloadValue(from?: HTMLElement | null): string {
  const sel = document.getElementById('modelSelect') as HTMLSelectElement | null;
  if (!sel) return '';

  let node: HTMLElement | null = from ?? null;
  while (node) {
    const resolve = loadUnloadValueResolvers.get(node);
    if (resolve) {
      const value = resolve().trim();
      if (value) return value;
      break;
    }
    node = node.parentElement;
  }

  return sel.value.trim();
}
