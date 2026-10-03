import {

  categoryForArea,

  SETTINGS_INTEGRATIONS_HUBS,

  hubForArea,

  type SettingsCategoryId,

  type SettingsIntegrationsHubId,

  type SettingsSectionId,

} from './settings-page-types';

import { refreshSettingsSection } from './settings-sections';

import { openSettings } from './settings-page';

import { resolveSettingsSectionNavigation } from './settings-section-navigation';

import type { SettingsSearchEntry } from './settings-search-types';
import { SETTINGS_NAV_GROUPS, SETTINGS_SECTION_LABELS } from './settings-page-types';

const TARGET_FLASH_CLASS = 'settings-search-target-flash';

const FLASH_MS = 1800;

const SETTINGS_CONTENT_SCROLL_PAD = 12;

// ── Scroll ───────────────────────────────────────────────────────────────────

/** Scroll inside `.settings-content` so floating OS window chrome is not shifted. */
export function scrollSettingsTargetIntoView(
  target: HTMLElement,
  options?: Pick<ScrollIntoViewOptions, 'block' | 'behavior'>,
): void {
  const scrollParent = target.closest('.settings-content');
  if (!(scrollParent instanceof HTMLElement)) {
    target.scrollIntoView(options);
    return;
  }

  const behavior = options?.behavior ?? 'smooth';
  const block = options?.block ?? 'start';
  const parentRect = scrollParent.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  let delta = 0;
  if (block === 'center') {
    delta =
      targetRect.top -
      parentRect.top -
      (parentRect.height - targetRect.height) / 2;
  } else if (block === 'end') {
    delta = targetRect.bottom - parentRect.bottom;
  } else {
    delta = targetRect.top - parentRect.top - SETTINGS_CONTENT_SCROLL_PAD;
  }

  scrollParent.scrollTo({
    top: Math.max(0, scrollParent.scrollTop + delta),
    behavior,
  });
}

/** Open ancestor disclosure panels so a search hit is visible. */
function expandSettingsDetailsForTarget(node: HTMLElement): void {
  let current: HTMLElement | null = node;
  while (current) {
    if (current instanceof HTMLDetailsElement) {
      current.open = true;
    }
    current = current.parentElement;
  }
}

function getSectionRoot(sectionId: SettingsSectionId): HTMLElement | null {

  return document.getElementById(`settingsSection-${sectionId}`);

}

function getCategoryPanel(category: SettingsCategoryId): HTMLElement | null {

  return document.querySelector(

    `.settings-category[data-category="${category}"]`,

  );

}

// ── Area ─────────────────────────────────────────────────────────────────────

/** Show one integrations hub panel; other hubs stay in the DOM for deep links and search. */

export function activateIntegrationsHub(hubId: string): void {

  const panel = document.querySelector(

    '.settings-category[data-category="integrations"]',

  );

  if (!panel) return;

  panel.querySelectorAll<HTMLElement>('.settings-hub').forEach((hub) => {

    hub.classList.toggle('is-active', hub.dataset.hub === hubId);

  });

}

function syncAreaPanels(area: SettingsSectionId): void {

  const category = categoryForArea(area);

  const panel = getCategoryPanel(category);

  if (!panel) return;

  if (category === 'integrations') {

    const hubId = hubForArea(area);

    if (hubId) activateIntegrationsHub(hubId);

    panel.querySelectorAll<HTMLElement>('.settings-area').forEach((section) => {

      section.classList.toggle('is-active', section.dataset.area === area);

    });

    return;

  }

  panel.querySelectorAll<HTMLElement>('.settings-area').forEach((section) => {

    section.classList.toggle('is-active', section.dataset.area === area);

  });

}

/** Ensure the area's category panel is visible, area active, and expand collapsed groups. */

export function ensureSettingsAreaVisible(sectionId: SettingsSectionId): void {
  const { sectionId: resolvedId } = resolveSettingsSectionNavigation(sectionId);

  const category = categoryForArea(resolvedId);

  const panel = getCategoryPanel(category);

  if (!panel?.classList.contains('is-active')) {

    document.querySelectorAll('.settings-category').forEach((node) => {

      node.classList.toggle('is-active', node === panel);

    });

  }

  syncAreaPanels(resolvedId);

  updateSettingsNavActive(

    resolvedId,

    category === 'integrations' ? hubForArea(resolvedId) : undefined,

  );

  const sectionRoot = getSectionRoot(resolvedId);

  if (!sectionRoot) return;

  // Field navigation below opens only the ancestors of the requested control.

}

/** Scroll to an integrations hub container and sync sidebar. */

export function scrollToSettingsHub(hubId: string): void {

  const hubDef = SETTINGS_INTEGRATIONS_HUBS.find((hub) => hub.id === hubId);

  const firstArea = hubDef?.areas[0];

  if (firstArea) ensureSettingsAreaVisible(firstArea);

  activateIntegrationsHub(hubId);

  updateSettingsNavActive(firstArea, hubId as SettingsIntegrationsHubId);

  const hub = document.getElementById(`settingsHub-${hubId}`);

  if (hub) scrollSettingsTargetIntoView(hub, { block: 'start', behavior: 'smooth' });

}

// ── Nav ──────────────────────────────────────────────────────────────────────

/** Highlight the unified sidebar item for an area or integrations hub. */

export function updateSettingsNavActive(

  area?: SettingsSectionId,

  hubId?: SettingsIntegrationsHubId,

): void {

  if (!area && hubId) area = SETTINGS_INTEGRATIONS_HUBS.find((hub) => hub.id === hubId)?.areas[0];
  if (area) {
    const group = SETTINGS_NAV_GROUPS.find((item) => item.sections.includes(area!));
    document.querySelectorAll<HTMLDetailsElement>('details.settings-nav-group').forEach((details) => {
      details.open = details.dataset.settingsNavGroup === group?.id;
    });
    const breadcrumb = document.getElementById('settingsLocation');
    if (breadcrumb) breadcrumb.textContent = `${group?.label ?? 'Settings'} / ${SETTINGS_SECTION_LABELS[area]}`;
    const estimate = document.getElementById('settingsPromptTokenEstimate');
    if (estimate) estimate.hidden = area !== 'agent-center';
  }

  const targetHub =

    hubId ??

    (area && categoryForArea(area) === 'integrations'

      ? hubForArea(area)

      : undefined);

  document.querySelectorAll<HTMLElement>('[data-settings-nav-area]').forEach((item) => {

    const isActive = Boolean(area) && item.dataset.settingsNavArea === area;

    item.classList.toggle('is-active', isActive);

    if (isActive) item.setAttribute('aria-current', 'page');

    else item.removeAttribute('aria-current');

  });

  document.querySelectorAll<HTMLElement>('[data-settings-nav-hub]').forEach((item) => {

    const isActive = Boolean(targetHub) && item.dataset.settingsNavHub === targetHub;

    item.classList.toggle('is-active', isActive);

    if (isActive) item.setAttribute('aria-current', 'page');

    else item.removeAttribute('aria-current');

  });

}

/** @deprecated Use updateSettingsNavActive */

export function updateSettingsSubnavActive(

  area?: SettingsSectionId,

  hubId?: string,

): void {

  updateSettingsNavActive(area, hubId as SettingsIntegrationsHubId | undefined);

}

/** Scroll to an area anchor within the active category panel. */

export function scrollToSettingsArea(

  sectionId: SettingsSectionId,

  options?: { skipActivation?: boolean },

): void {

  if (!options?.skipActivation) {

    ensureSettingsAreaVisible(sectionId);

  }

  const root = getSectionRoot(sectionId);

  if (root) scrollSettingsTargetIntoView(root, { block: 'start', behavior: 'smooth' });

}

// ── Search ───────────────────────────────────────────────────────────────────

/** Resolve scroll target: search key, then first group, then section root. */

export function resolveSettingsSearchDomTarget(

  sectionId: SettingsSectionId,

  searchKey?: string,

): HTMLElement | null {

  const resolved = resolveSettingsSectionNavigation(sectionId, searchKey);

  ensureSettingsAreaVisible(resolved.sectionId);

  const sectionRoot = getSectionRoot(resolved.sectionId);

  if (!sectionRoot) return null;

  if (resolved.searchKey) {

    const escaped = resolved.searchKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const keyed = sectionRoot.querySelector(

      `[data-settings-search-key="${escaped}"]`,

    );

    if (keyed instanceof HTMLElement) {
      expandSettingsDetailsForTarget(keyed);
      return keyed;
    }

  }

  const group = sectionRoot.querySelector('.settings-group');

  if (group instanceof HTMLElement) return group;

  return sectionRoot;

}

/** Brief highlight so users see where they landed. */

export function flashSettingsSearchTarget(node: HTMLElement): void {

  node.classList.add(TARGET_FLASH_CLASS);

  window.setTimeout(() => {

    node.classList.remove(TARGET_FLASH_CLASS);

  }, FLASH_MS);

}

/** Open settings or Models app, refresh the section, then scroll to the resolved target. */

export async function navigateToSettingsSearchEntry(

  entry: SettingsSearchEntry,

): Promise<void> {

  if (entry.modelsSection) {

    const { openModels } = await import('./models-page');

    openModels(entry.modelsSection as import('./models-page').ModelsSectionId);

    return;

  }

  if (entry.brainSection) {
    const { openBrain } = await import('./brain-page');
    openBrain(entry.brainSection as import('./brain-page').BrainSectionId);
    return;
  }



  const resolved = resolveSettingsSectionNavigation(entry.sectionId, entry.searchKey);

  openSettings(resolved.sectionId, { searchKey: resolved.searchKey });

  await refreshSettingsSection(resolved.sectionId);

  await new Promise<void>((resolve) => {

    requestAnimationFrame(() => {

      requestAnimationFrame(() => resolve());

    });

  });

  const target = resolveSettingsSearchDomTarget(

    entry.sectionId,

    entry.searchKey,

  );

  if (!target) return;

  scrollSettingsTargetIntoView(target, { block: 'center', behavior: 'smooth' });

  flashSettingsSearchTarget(target);

}

