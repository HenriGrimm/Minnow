/**
 * "When does this take effect?" badges. The catalog says which settings apply
 * immediately, on the next message, after reopening a file or after a restart;
 * this marks the matching rows once a section renders, so the answer comes from
 * one table instead of being written (or forgotten) in each section's prose.
 */

import { SETTINGS_FIELD_CATALOG, type SettingsApplies } from './settings-catalog';

const LABELS: Record<SettingsApplies, { text: string; title: string }> = {
  now: { text: 'Applies now', title: 'Takes effect as soon as you change it.' },
  'next-turn': { text: 'Next message', title: 'Takes effect from the next message you send.' },
  reopen: { text: 'Reopen file', title: 'Takes effect when you reopen a file.' },
  restart: { text: 'After restart', title: 'Takes effect after Minnow restarts.' },
  workspace: { text: 'This workspace', title: 'Saved for the current workspace only.' },
};

const BADGE_CLASS = 'settings-apply-badge';

const APPLIES_BY_KEY = new Map(
  SETTINGS_FIELD_CATALOG.filter((field) => field.applies).map((field) => [field.key, field.applies!]),
);

function titleElement(node: HTMLElement): HTMLElement | null {
  if (node.matches('.settings-group')) return node.querySelector<HTMLElement>(':scope > .settings-group__title');
  return node.querySelector<HTMLElement>('.settings-toggle-row__label, .settings-row__title, .graphite-appearance-row__title, .settings-kv__term')
    ?? (node.matches('.settings-kv__term') ? node : null);
}

/** Add apply-timing badges to keyed rows under `root` (idempotent). */
export function decorateSettingsApplyBadges(root: ParentNode | null): void {
  if (!root) return;
  for (const node of root.querySelectorAll<HTMLElement>('[data-settings-search-key]')) {
    const applies = APPLIES_BY_KEY.get(node.dataset.settingsSearchKey ?? '');
    if (!applies) continue;
    const title = titleElement(node);
    if (!title || title.querySelector(`.${BADGE_CLASS}`)) continue;
    const badge = document.createElement('span');
    badge.className = `${BADGE_CLASS} ${BADGE_CLASS}--${applies}`;
    badge.textContent = LABELS[applies].text;
    badge.title = LABELS[applies].title;
    title.append(' ', badge);
  }
}
