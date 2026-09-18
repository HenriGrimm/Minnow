import type { ModelsSectionId } from './models-page';
import type { SettingsSectionId } from './settings-page-types';
import { resolveSettingsSectionNavigation } from './settings-section-navigation';
import { modelsSectionForSettingsArea } from './models-settings-navigation';

const REPOSITORY_DOC_BASE = 'https://github.com/HenriGrimm/Minnow/blob/main/';

export type SettingsFieldOptions = {
  key: string;
  label: string;
  description?: string;
  control: HTMLElement;
};

/** Single labeled control row with a searchable anchor. */
export function createSettingsField(opts: SettingsFieldOptions): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-field';
  row.dataset.settingsSearchKey = opts.key;

  const label = document.createElement('label');
  label.className = 'settings-field__label';
  label.textContent = opts.label;

  const controlWrap = document.createElement('div');
  controlWrap.className = 'settings-field__control';
  controlWrap.appendChild(opts.control);

  row.append(label, controlWrap);

  if (opts.description) {
    const hint = document.createElement('p');
    hint.className = 'settings-field__hint field-hint';
    hint.textContent = opts.description;
    row.appendChild(hint);
  }

  return row;
}

export type SettingsGroupOptions = {
  /** Bordered panel surface (used on General settings groups). */
  emphasis?: boolean;
};

/** Wrap related controls in a titled panel for scanability. */
export function appendSettingsGroup(
  mount: HTMLElement,
  title: string,
  hint?: string,
  searchKey?: string,
  options?: SettingsGroupOptions,
): HTMLElement {
  const group = document.createElement('section');
  group.className = 'settings-group';
  if (options?.emphasis) {
    group.classList.add('settings-group--emphasis');
  }
  if (searchKey) {
    group.dataset.settingsSearchKey = searchKey;
  }

  const heading = document.createElement('h3');
  heading.className = 'settings-group__title';
  heading.textContent = title;
  group.appendChild(heading);

  if (hint) {
    const lead = document.createElement('p');
    lead.className = 'settings-group__lead';
    lead.textContent = hint;
    group.appendChild(lead);
  }

  const body = document.createElement('div');
  body.className = 'settings-group__body';
  group.appendChild(body);
  mount.appendChild(group);
  return body;
}

/** Related settings links row (hub cross-navigation). */
export function appendSettingsCrosslinks(
  mount: HTMLElement,
  links: { label: string; sectionId: string }[],
): void {
  const cross = document.createElement('div');
  cross.className = 'settings-crosslinks';
  const label = document.createElement('span');
  label.className = 'settings-crosslinks__label';
  label.textContent = 'Related';
  cross.appendChild(label);
  for (const link of links) {
    cross.appendChild(linkToSettingsSection(link.label, link.sectionId));
  }
  mount.appendChild(cross);
}

type SettingsLayoutNavHandlers = {
  openSettings: (section: SettingsSectionId) => void;
  openModels: (section: ModelsSectionId) => void;
};

let navHandlersForTests: SettingsLayoutNavHandlers | null = null;

/** Override cross-link navigation in unit tests (restored by passing null). */
export function setSettingsLayoutNavHandlersForTests(
  handlers: SettingsLayoutNavHandlers | null,
): void {
  navHandlersForTests = handlers;
}

function openSettingsSection(
  sectionId: SettingsSectionId,
  searchKey?: string,
): void {
  const resolved = resolveSettingsSectionNavigation(sectionId, searchKey);
  if (navHandlersForTests) {
    navHandlersForTests.openSettings(resolved.sectionId);
    return;
  }
  void import('./settings-page').then((m) =>
    m.openSettings(resolved.sectionId, { searchKey: resolved.searchKey }),
  );
}

function openModelsSection(sectionId: ModelsSectionId): void {
  if (navHandlersForTests) {
    navHandlersForTests.openModels(sectionId);
    return;
  }
  void import('./models-page').then((m) => m.openModels(sectionId));
}

/** Jump to another settings (or Models) section. Uses open APIs, not hash-only. */
export function linkToSettingsSection(
  label: string,
  sectionId: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'settings-inline-link';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    const resolved = resolveSettingsSectionNavigation(sectionId as SettingsSectionId);
    const modelsSection = modelsSectionForSettingsArea(resolved.sectionId);
    if (modelsSection) {
      openModelsSection(modelsSection as ModelsSectionId);
      return;
    }
    openSettingsSection(resolved.sectionId, resolved.searchKey);
  });
  return btn;
}

/** In-app product wiki deep link (user manual pages). */
export function productWikiHref(docPath: string): string {
  const path = docPath.startsWith('documentation/')
    ? docPath
    : `documentation/${docPath}`;
  return `#/wiki/${encodeURIComponent(path)}`;
}

/** Open a shipped manual page from settings copy. */
export function linkToProductWiki(label: string, docPath: string): HTMLAnchorElement {
  const path = docPath.startsWith('documentation/')
    ? docPath
    : `documentation/${docPath}`;
  const anchor = document.createElement('a');
  anchor.className = 'settings-inline-link';
  anchor.textContent = label;
  anchor.href = productWikiHref(path);
  anchor.addEventListener('click', (event) => {
    event.preventDefault();
    void import('./product-wiki').then((m) => m.openProductWiki(path));
  });
  return anchor;
}

/** Open repository documentation that is not in the in-app manual catalog. */
export function linkToRepositoryDoc(label: string, docPath: string): HTMLAnchorElement {
  const normalized = docPath.replaceAll('\\', '/');
  const anchor = document.createElement('a');
  anchor.className = 'settings-inline-link';
  anchor.textContent = label;
  anchor.href = `${REPOSITORY_DOC_BASE}${normalized}`;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

/** Jump to a Models app section (e.g. Voice). */
export function linkToModelsSection(
  label: string,
  sectionId: import('./models-page').ModelsSectionId = 'voice',
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'settings-inline-link';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    void import('./models-page').then((m) => m.openModels(sectionId));
  });
  return btn;
}
