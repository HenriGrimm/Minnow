import { iconHtml } from './icon';
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
  active: string | null;
  pinned: boolean;
  timer?: ReturnType<typeof setTimeout>;
  navigate?: (event: KeyboardEvent) => boolean;
  collapse?: () => void;
}
const browsers = new WeakMap<HTMLElement, BrowserState>();
let browserId = 0;

export function resetModelProviderBrowser(menu: HTMLElement): void {
  const state = browsers.get(menu);
  if (!state) return;
  clearTimeout(state.timer);
  state.active = null;
  state.pinned = false;
  state.navigate = undefined;
  state.collapse = undefined;
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
): void {
  const state: BrowserState = browsers.get(menu) ?? { active: null, pinned: false };
  if (!browsers.has(menu)) {
    browsers.set(menu, state);
    menu.addEventListener('keydown', event => {
      if (!event.defaultPrevented) handleModelProviderBrowserKeydown(menu, event);
    });
    menu.addEventListener('pointerleave', () => {
      clearTimeout(state.timer);
      if (!state.pinned && !menu.contains(document.activeElement)) state.collapse?.();
    });
  }
  const current = state;
  clearTimeout(current.timer);
  const prefs = readModelPickerPreferences();
  const usage = new Map(Object.entries(prefs.usage));
  groups.sort((a, b) => {
    if (prefs.sort === 'local') return Number(b.local) - Number(a.local) || a.label.localeCompare(b.label);
    if (prefs.sort === 'smart') {
      const rank = Number(b.hasFavorites) - Number(a.hasFavorites)
        || (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0);
      if (rank) return rank;
    }
    return a.label.localeCompare(b.label);
  });
  menu.classList.add('model-provider-browser');
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', 'Browse models');
  const id = `model-provider-pane-${++browserId}`;
  const favoriteSection = document.createElement('li');
  favoriteSection.className = 'model-picker-favorites';
  favoriteSection.setAttribute('role', 'presentation');
  const heading = document.createElement('div');
  heading.className = 'model-browser-heading';
  heading.innerHTML = iconHtml('star');
  const title = document.createElement('span');
  title.textContent = 'Favorites';
  const count = document.createElement('span');
  count.className = 'model-browser-count';
  count.textContent = String(favorites.length);
  heading.append(title, count);
  const favoriteList = document.createElement('ul');
  favoriteList.className = 'model-browser-models model-browser-favorite-list';
  favoriteList.setAttribute('role', 'listbox');
  favoriteList.setAttribute('aria-label', 'Favorite models');
  for (const entry of favorites) appendEntry(favoriteList, entry);
  favoriteSection.append(heading, favoriteList);
  if (!favorites.length) {
    const empty = document.createElement('div');
    empty.className = 'model-browser-favorites-empty';
    empty.textContent = 'Star a model to keep it here.';
    favoriteSection.appendChild(empty);
  }

  const browse = document.createElement('li');
  browse.className = 'model-browser-providers';
  browse.setAttribute('role', 'presentation');
  const toolbar = document.createElement('div');
  toolbar.className = 'model-browser-heading';
  const providersLabel = document.createElement('span');
  providersLabel.textContent = 'Providers';
  const sort = document.createElement('select');
  sort.className = 'model-browser-sort';
  sort.setAttribute('aria-label', 'Sort providers');
  sort.title = 'Smart order puts providers with favorites first, then your most used providers';
  for (const [value, label] of [['smart', 'Smart order'], ['name', 'Name A–Z'], ['local', 'Local first']]) {
    const option = document.createElement('option');
    option.value = value;
    option.text = label;
    sort.appendChild(option);
  }
  sort.value = prefs.sort;
  sort.addEventListener('change', () => { setModelProviderSort(sort.value as ModelProviderSort); rerender(); });
  toolbar.append(providersLabel, sort);
  const columns = document.createElement('div');
  columns.className = 'model-browser-columns';
  const rail = document.createElement('div');
  rail.className = 'model-browser-rail';
  rail.setAttribute('role', 'group');
  rail.setAttribute('aria-label', 'Providers');
  const pane = document.createElement('div');
  pane.className = 'model-browser-pane';
  pane.id = id;
  const buttons: HTMLButtonElement[] = [];
  function activate(providerId: string | null, pinned: boolean): void {
    clearTimeout(current.timer);
    const group = groups.find(candidate => candidate.id === providerId);
    current.active = group?.id ?? null;
    current.pinned = Boolean(group && pinned);
    buttons.forEach(button => button.setAttribute('aria-expanded', String(button.dataset.providerId === current.active)));
    pane.replaceChildren();
    if (!group) {
      const empty = document.createElement('div');
      empty.className = 'model-browser-empty';
      const label = document.createElement('strong');
      label.textContent = 'Browse a provider';
      const hint = document.createElement('span');
      hint.textContent = 'Hover to preview models. Click to keep a group open.';
      empty.append(label, hint);
      pane.appendChild(empty);
    } else {
      const label = document.createElement('div');
      label.className = 'model-browser-pane-heading';
      label.textContent = `${group.label} · ${group.local ? 'Local' : 'Cloud'}${current.pinned ? ' · Pinned' : ''}`;
      const list = document.createElement('ul');
      list.className = 'model-browser-models';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', `${group.label} models`);
      group.entries.forEach(entry => appendEntry(list, entry));
      pane.append(label, list);
    }
    menu.removeAttribute('aria-activedescendant');
    menu.querySelectorAll('.model-select-option--active').forEach(row => row.classList.remove('model-select-option--active'));
  }
  for (const group of groups) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-browser-provider';
    button.dataset.providerId = group.id;
    button.setAttribute('aria-controls', id);
    button.setAttribute('aria-expanded', 'false');
    const mark = document.createElement('span');
    mark.className = 'model-browser-provider-mark';
    mark.setAttribute('aria-hidden', 'true');
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
      mark.innerHTML = iconHtml('globe');
    }
    const name = document.createElement('span');
    name.className = 'model-browser-provider-name';
    name.textContent = group.label;
    const count = document.createElement('span');
    count.className = 'model-browser-count';
    count.textContent = String(group.entries.length);
    const chevron = document.createElement('span');
    chevron.innerHTML = iconHtml('chevronRight');
    chevron.setAttribute('aria-hidden', 'true');
    button.append(mark, name, count, chevron);
    button.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch' || current.pinned || current.active === group.id) return;
      clearTimeout(current.timer);
      current.timer = setTimeout(() => {
        if (button.isConnected && !current.pinned) activate(group.id, false);
      }, 180);
    });
    button.addEventListener('pointerleave', () => clearTimeout(current.timer));
    button.addEventListener('focus', () => { if (!current.pinned && current.active !== group.id) activate(group.id, false); });
    button.addEventListener('click', () => {
      if (current.active === group.id && current.pinned) activate(null, false);
      else activate(group.id, true);
    });
    buttons.push(button);
    rail.appendChild(button);
  }
  columns.append(rail, pane);
  browse.append(toolbar, columns);
  menu.append(favoriteSection, browse);
  activate(current.active, current.pinned);
  current.collapse = () => activate(null, false);
  current.navigate = event => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest) return false;
    // Stars, sorting, and reasoning keep their native keyboard behavior.
    if (target.closest('.model-select-favorite, select, .model-menu-actions, .composer-model-reasoning')) return false;
    const provider = target.closest<HTMLButtonElement>('.model-browser-provider');
    const row = target.closest<HTMLElement>('.model-select-option');
    if (provider && event.key === 'ArrowRight') {
      activate(provider.dataset.providerId ?? null, true);
      pane.querySelector<HTMLElement>('.model-select-option')?.focus();
    } else if (pane.contains(target) && event.key === 'ArrowLeft') {
      buttons.find(button => button.dataset.providerId === current.active)?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (target.tagName === 'INPUT' && ['Home', 'End'].includes(event.key)) return false;
      let targets: HTMLElement[];
      if (provider) targets = buttons;
      else if (row && pane.contains(row)) targets = [...pane.querySelectorAll<HTMLElement>('.model-select-option')];
      else targets = [...menu.querySelectorAll<HTMLElement>('.model-select-reset'), ...favoriteList.querySelectorAll<HTMLElement>('.model-select-option'), ...buttons];
      if (!targets.length) return false;
      const index = targets.indexOf(target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? targets.length - 1
        : index < 0 ? (event.key === 'ArrowUp' ? targets.length - 1 : 0)
          : Math.max(0, Math.min(targets.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
      targets[next]?.focus();
      targets[next]?.scrollIntoView({ block: 'nearest' });
    } else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
}
