import { createIcon, iconHtml } from './icon';
import { ROUTER_PROVIDER_ID } from '../models/routers';
import { providerLogoId } from '../providers/identity';
import { getCachedProviderList } from '../providers/store';
import {
  readModelPickerPreferences,
  setModelProviderSort,
  type ModelProviderSort,
} from '../models/model-picker-preferences';

export interface ModelBrowserGroup<T> {
  id: string;
  label: string;
  local: boolean;
  entries: T[];
  hasFavorites: boolean;
}

interface BrowserState {
  active?: string | typeof FAVORITES;
  navigate?: (event: KeyboardEvent) => boolean;
}

const FAVORITES = Symbol('Favorites');
const browsers = new WeakMap<HTMLElement, BrowserState>();
let browserId = 0;

export function resetModelProviderBrowser(menu: HTMLElement): void {
  browsers.delete(menu);
}

/** Owners with capture-phase keyboard handlers delegate before their legacy list navigation. */
export function handleModelProviderBrowserKeydown(menu: HTMLElement, event: KeyboardEvent): boolean {
  return browsers.get(menu)?.navigate?.(event) ?? false;
}

export function renderModelProviderBrowser<T>(
  menu: HTMLUListElement,
  groups: ModelBrowserGroup<T>[],
  favorites: T[],
  appendEntry: (list: HTMLUListElement, entry: T) => void,
  rerender: () => void,
  selectedProviderId?: string,
): void {
  const state = browsers.get(menu) ?? {};
  browsers.set(menu, state);
  menu.onkeydown = event => {
    if (!event.defaultPrevented) handleModelProviderBrowserKeydown(menu, event);
  };
  const prefs = readModelPickerPreferences();
  groups.sort((a, b) => {
    if (prefs.sort === 'local') return Number(b.local) - Number(a.local) || a.label.localeCompare(b.label);
    if (prefs.sort === 'smart') {
      const rank = Number(b.hasFavorites) - Number(a.hasFavorites)
        || (prefs.usage[b.id] ?? 0) - (prefs.usage[a.id] ?? 0);
      if (rank) return rank;
    }
    return a.label.localeCompare(b.label);
  });

  menu.classList.add('model-provider-browser');
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', 'Browse models');
  const browse = document.createElement('li');
  browse.className = 'model-browser-providers';
  browse.setAttribute('role', 'presentation');
  const columns = document.createElement('div');
  columns.className = 'model-browser-columns';
  const rail = document.createElement('div');
  rail.className = 'model-browser-rail';
  const tabList = document.createElement('div');
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', 'Model providers and favorites');
  tabList.setAttribute('aria-orientation', 'vertical');
  rail.append(tabList);
  const pane = document.createElement('div');
  pane.className = 'model-browser-pane';
  pane.id = `model-provider-pane-${++browserId}`;
  pane.setAttribute('role', 'tabpanel');
  const tabs = new Map<string | typeof FAVORITES, HTMLButtonElement>();
  const isPhone = document.documentElement.classList.contains('mn-phone');
  const defaultProvider = groups.find(group => group.id === selectedProviderId)?.id ?? groups[0]?.id;

  const sort = document.createElement('select');
  sort.className = 'model-browser-sort';
  sort.setAttribute('aria-label', 'Sort providers');
  for (const [value, label] of [['smart', 'Smart order'], ['name', 'Name A–Z'], ['local', 'Local first']]) {
    const option = document.createElement('option');
    option.value = value;
    option.text = label;
    sort.append(option);
  }
  sort.value = prefs.sort;
  sort.addEventListener('change', () => {
    setModelProviderSort(sort.value as ModelProviderSort);
    rerender();
    menu.querySelector<HTMLSelectElement>('.model-browser-sort')?.focus();
  });

  function activate(key?: string | typeof FAVORITES): void {
    state.active = key;
    columns.classList.toggle('is-provider-open', key !== undefined);
    const activeTab = key === undefined ? undefined : tabs.get(key);
    for (const tab of tabs.values()) {
      tab.setAttribute('aria-selected', String(tab === activeTab));
      tab.tabIndex = tab === (activeTab ?? tabs.get(FAVORITES)) ? 0 : -1;
    }
    pane.replaceChildren();
    if (!activeTab) {
      pane.removeAttribute('aria-labelledby');
      rail.prepend(sort);
      return;
    }
    pane.setAttribute('aria-labelledby', activeTab.id);
    const group = groups.find(candidate => candidate.id === key);
    const heading = document.createElement('div');
    heading.className = 'model-browser-pane-heading';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'model-browser-back';
    back.setAttribute('aria-label', 'Back to providers');
    back.innerHTML = iconHtml('chevronLeft');
    back.addEventListener('click', () => {
      activate();
      for (const tab of tabs.values()) tab.tabIndex = tab === activeTab ? 0 : -1;
      activeTab.focus();
    });
    heading.append(back, group?.label ?? 'Favorites');
    if (!isPhone) heading.append(sort);
    const list = document.createElement('ul');
    list.className = 'model-browser-models';
    if (!group) list.classList.add('model-browser-favorite-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', group ? `${group.label} models` : 'Favorite models');
    for (const entry of group?.entries ?? favorites) appendEntry(list, entry);
    pane.append(heading, list);
    if (!group && !favorites.length) {
      const empty = document.createElement('p');
      empty.className = 'model-browser-favorites-empty';
      empty.textContent = 'Star a model to keep it here.';
      const emptyRow = document.createElement('li');
      emptyRow.setAttribute('role', 'presentation');
      emptyRow.append(empty);
      list.append(emptyRow);
    }
  }

  function addTab(key: string | typeof FAVORITES, label: string, mark: HTMLElement): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = key === FAVORITES ? 'model-browser-tab model-browser-favorites-tab' : 'model-browser-tab model-browser-provider';
    if (typeof key === 'string') button.dataset.providerId = key;
    button.id = `${pane.id}-tab-${tabs.size}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', pane.id);
    const name = document.createElement('span');
    name.className = 'model-browser-provider-name';
    name.textContent = label;
    button.append(mark, name);
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-selected') !== 'true') activate(key);
      if (isPhone) pane.querySelector<HTMLButtonElement>('.model-browser-back')?.focus({ preventScroll: true });
    });
    tabs.set(key, button);
    tabList.append(button);
  }

  const star = document.createElement('span');
  star.className = 'model-browser-provider-mark';
  star.setAttribute('aria-hidden', 'true');
  star.innerHTML = iconHtml('starFilled');
  addTab(FAVORITES, 'Favorites', star);
  for (const group of groups) {
    const mark = document.createElement('span');
    mark.className = 'model-browser-provider-mark';
    mark.setAttribute('aria-hidden', 'true');
    if (group.id === ROUTER_PROVIDER_ID) {
      mark.append(createIcon('modelPool'));
      addTab(group.id, group.label, mark);
      continue;
    }
    const provider = getCachedProviderList()?.providers.find(candidate => candidate.id === group.id);
    const logo = group.id === 'minnow-library' ? 'minnow' : providerLogoId(provider ?? {
      id: group.id,
      label: group.label,
      baseUrl: '',
      apiKind: /^(codex|claude|claude-code|cursor|cursor-agent)(-cli)?$/.test(group.id) ? 'agent-cli-v1' : 'openai-v1',
    });
    if (logo) {
      const glyph = document.createElement('span');
      glyph.className = 'model-browser-provider-glyph';
      glyph.style.maskImage = `url("${logo === 'minnow' ? '/logos/minnow-glyph.svg' : `/logos/providers/${logo}.svg`}")`;
      mark.dataset.logo = logo;
      mark.append(glyph);
    } else {
      mark.textContent = group.label.slice(0, 2).toUpperCase();
    }
    addTab(group.id, group.label, mark);
  }
  columns.append(rail, pane);
  browse.append(columns);
  menu.append(browse);
  activate(state.active !== undefined && tabs.has(state.active) ? state.active : isPhone ? undefined : defaultProvider);

  state.navigate = event => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest || target.closest('.model-select-favorite, select, .model-menu-actions, .composer-model-reasoning')) return false;
    const tab = target.closest<HTMLButtonElement>('.model-browser-tab');
    const rows = [...pane.querySelectorAll<HTMLElement>('.model-select-option')];
    if (tab && event.key === 'ArrowRight') {
      tab.click();
      pane.querySelector<HTMLElement>('.model-select-option')?.focus();
    } else if (pane.contains(target) && event.key === 'ArrowLeft') {
      if (isPhone) pane.querySelector<HTMLButtonElement>('.model-browser-back')?.click();
      else rail.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (target.tagName === 'INPUT' && ['Home', 'End'].includes(event.key)) return false;
      const targets = tab ? [...tabs.values()] : rows.includes(target) ? rows
        : [...menu.querySelectorAll<HTMLElement>('.model-select-reset'), ...rows, ...(!rows.length ? tabs.values() : [])];
      if (!targets.length) return false;
      const index = targets.indexOf(target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? targets.length - 1
        : index < 0 ? (event.key === 'ArrowUp' ? targets.length - 1 : 0)
          : Math.max(0, Math.min(targets.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
      const element = targets[next];
      if (tab && !isPhone) element.click();
      else if (tab) {
        tab.tabIndex = -1;
        element.tabIndex = 0;
      }
      element.focus();
      element.scrollIntoView({ block: 'nearest' });
    } else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
}
