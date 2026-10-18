import type { ModelPoolBrowser } from './model-pool-picker';

interface PoolPickerHostOptions {
  panel: HTMLElement;
  menu: HTMLUListElement;
  filterBar: HTMLElement;
  select: () => HTMLSelectElement | null;
  selectedValue: () => string;
  query: () => string;
  pick: (value: string) => void;
  renderModels: () => void;
  closeMenu: () => void;
  layout?: () => void;
}
interface PoolPickerHost {
  active: boolean;
  refresh: () => void;
  leave: (next: () => void) => boolean;
}
const hosts = new WeakMap<HTMLElement, PoolPickerHost>();

/** Pool browsing is a menu view, separate from the persisted local/cloud filter. */
export function mountModelPoolPickerHost(options: PoolPickerHostOptions): void {
  const { panel, menu, filterBar } = options;
  if (hosts.has(panel)) return;
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'model-host-filter-segment model-pool-tab';
  tab.textContent = 'Pools';
  tab.setAttribute('role', 'radio');
  tab.setAttribute('aria-checked', 'false');
  filterBar.querySelector('.model-host-filter-segmented')?.append(tab);
  const content = document.createElement('section');
  content.className = 'model-pool-host';
  content.setAttribute('aria-label', 'Model pools');
  content.hidden = true;
  panel.append(content);
  let browser: ModelPoolBrowser | undefined;
  let epoch = 0;
  let previousFilter: Element | null = null;
  let removalObserver: MutationObserver | undefined;
  const search = filterBar.querySelector<HTMLInputElement>('.model-host-filter-search');
  const syncTabs = (): void => {
    tab.setAttribute('aria-checked', String(host.active));
    if (host.active) filterBar.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-checked', 'false'));
    else previousFilter?.setAttribute('aria-checked', 'true');
    if (search) {
      search.placeholder = host.active ? 'Search pools or their models…' : 'Search models or providers…';
      search.setAttribute('aria-label', host.active ? 'Search pools or their models' : 'Search models or providers');
    }
  };
  const close = (): void => {
    epoch++;
    removalObserver?.disconnect(); removalObserver = undefined;
    browser?.dispose(); browser = undefined;
    host.active = false;
    content.hidden = true;
    content.replaceChildren();
    panel.classList.remove('is-browsing-pools', 'is-editing-pool');
    syncTabs();
  };
  const host: PoolPickerHost = {
    active: false,
    refresh: () => { syncTabs(); browser?.refreshSearch(); },
    leave: next => {
      if (!host.active) return true;
      if (browser && !browser.requestLeave(() => { close(); next(); })) return false;
      close();
      return true;
    },
  };
  hosts.set(panel, host); hosts.set(menu, host);
  const show = async (): Promise<void> => {
    if (host.active) return;
    host.active = true;
    previousFilter = filterBar.querySelector('[data-filter][aria-checked="true"]');
    const Observer = panel.ownerDocument.defaultView?.MutationObserver;
    if (Observer) {
      removalObserver = new Observer(() => { if (!panel.isConnected) close(); });
      removalObserver.observe(panel.ownerDocument.body, { childList: true, subtree: true });
    }
    content.hidden = false;
    content.textContent = 'Loading model pools…';
    panel.classList.add('is-browsing-pools');
    syncTabs(); options.layout?.();
    const current = ++epoch;
    try {
      const { mountModelPoolBrowser } = await import('./model-pool-picker');
      if (current !== epoch || !host.active || !panel.isConnected) return;
      browser = mountModelPoolBrowser(content, {
        select: options.select, selectedValue: options.selectedValue, query: options.query, pick: options.pick,
        onEditing: editing => { panel.classList.toggle('is-editing-pool', editing); options.layout?.(); },
        onLayout: options.layout,
        manage: () => {
          close(); options.closeMenu();
          void import('./models-page').then(module => module.openModels('routers'));
        },
      });
    } catch (error) {
      if (current !== epoch) return;
      content.replaceChildren();
      const message = document.createElement('p'); message.textContent = `Could not open model pools: ${(error as Error).message}`;
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry';
      retry.onclick = () => { close(); void show(); };
      content.append(message, retry);
    }
  };
  tab.addEventListener('click', () => { void show(); });
  // Resolve a draft before the existing host-filter handler changes the catalog.
  filterBar.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-filter]');
    if (!button || !host.active) return;
    event.preventDefault(); event.stopPropagation();
    if (host.leave(() => button.click())) button.click();
  }, true);
}

export function refreshModelPoolPicker(menu: HTMLElement): boolean {
  const host = hosts.get(menu);
  if (!host?.active) return false;
  host.refresh();
  return true;
}

/** Returns false when a draft or in-flight save must be resolved first. */
export function leaveModelPoolPicker(panel: HTMLElement | null, next: () => void): boolean {
  return !panel || (hosts.get(panel)?.leave(next) ?? true);
}
