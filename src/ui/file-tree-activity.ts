/** Local progress for context-menu and drop operations whose menu has closed. */
let activeOperations = 0;
let indicator: HTMLElement | null = null;

export function beginFileTreeActivity(label: string): () => void {
  if (typeof document === 'undefined') return () => {};
  const host = document.getElementById('fileTreeHost');
  if (!host) return () => {};
  activeOperations += 1;
  host.setAttribute('aria-busy', 'true');
  if (!indicator?.isConnected) {
    indicator = document.createElement('div');
    indicator.className = 'file-tree-row';
    indicator.setAttribute('role', 'status');
    const spinner = document.createElement('span');
    spinner.className = 'mn-action-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    indicator.append(spinner, document.createElement('span'));
    host.prepend(indicator);
  }
  indicator.lastElementChild!.textContent = label;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeOperations -= 1;
    if (activeOperations > 0) return;
    host.removeAttribute('aria-busy');
    indicator?.remove();
    indicator = null;
  };
}
