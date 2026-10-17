import { normalizeModeId, type ModeId } from '../chat/modes/types';
import { applyIcon, createIcon, type IconName } from './icon';

const MODE_TO_ICON: Record<ModeId, IconName> = {
  general: 'modeGeneral',
  desktop: 'modeGeneral',
  email: 'modeGeneral',
  build: 'modeBuild',
  plan: 'modePlan',
  'super-plan': 'modeSuperPlan',
  orchestrate: 'modeOrchestrate',
  debug: 'modeDebug',
  onboarding: 'modeGeneral',
};

/** Resolve semantic icon name for a persisted or unknown mode id. */
export function modeIconName(modeId: string | null | undefined): IconName {
  return MODE_TO_ICON[normalizeModeId(modeId)];
}

/** Sidebar chat rows use the same solid glyphs as the composer mode strip. */
export function chatListModeIconName(modeId: string | null | undefined): IconName {
  return modeIconName(modeId);
}

/** @deprecated Use modeIconName — kept for callers expecting a URL string. */
export function modeIconSrc(modeId: string | null | undefined): string {
  return modeIconName(modeId);
}

/** @deprecated Use chatListModeIconName. */
export function chatListModeIconSrc(modeId: string | null | undefined): string {
  return chatListModeIconName(modeId);
}

/** Create a mode icon element (sidebar rail + compact rows). */
export function createModeMaskIcon(
  modeId: ModeId | string | null | undefined,
  className = 'mode-mask-icon',
): HTMLElement {
  const el = createIcon(chatListModeIconName(modeId), { className });
  applyModeMaskIcon(el, modeId);
  return el;
}

/** Footer / hub sized mode icon (18px via `.mode-mask-icon--lg`). */
export function createModeMaskIconLg(
  modeId: ModeId | string | null | undefined,
  className = 'mode-mask-icon mode-mask-icon--lg',
): HTMLElement {
  return createModeMaskIcon(modeId, className);
}

/** Sync mode icon data-mode-id when chat mode changes without rebuilding the row. */
export function applyModeMaskIcon(
  el: HTMLElement,
  modeId: ModeId | string | null | undefined,
): void {
  const normalized = normalizeModeId(modeId);
  el.dataset.modeId = normalized;
  applyIcon(el, chatListModeIconName(modeId));
}

/** Update mode glyphs for a chat across all sidebar / rail lists. */
export function syncModeIconInDom(
  chatId: string,
  modeId: ModeId | string | null | undefined,
): void {
  const iconName = chatListModeIconName(modeId);
  const normalized = normalizeModeId(modeId);
  document
    .querySelectorAll<HTMLElement>(`.chat-item-row[data-chat-id="${chatId}"] .mode-mask-icon`)
    .forEach((icon) => {
      icon.dataset.modeId = normalized;
      applyIcon(icon, iconName);
    });
}
