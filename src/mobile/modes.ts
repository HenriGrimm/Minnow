/** Mode glyphs and pickers shared by the chat list and the thread. */

import { getMode, listComposerModes, normalizeModeId } from '../chat/modes/registry';
import type { ModeId } from '../chat/modes/types';
import { ICON_CLASS } from '../ui/icon';
import { pickFromSheet } from './sheet';

const MODE_GLYPH: Partial<Record<ModeId, string>> = {
  general: ICON_CLASS.modeGeneral,
  build: ICON_CLASS.modeBuild,
  plan: ICON_CLASS.modePlan,
  debug: ICON_CLASS.modeDebug,
  orchestrate: ICON_CLASS.modeOrchestrate,
};

export function modeGlyph(modeId: ModeId | undefined): string {
  return MODE_GLYPH[normalizeModeId(modeId)] ?? ICON_CLASS.modeGeneral;
}

export function modeLabel(modeId: ModeId | undefined): string {
  return getMode(normalizeModeId(modeId)).label;
}

/** Let the user pick a composer mode. Resolves null when dismissed. */
export function pickMode(current: ModeId | undefined, title = 'Mode'): Promise<ModeId | null> {
  const selected = normalizeModeId(current);
  return pickFromSheet(
    title,
    listComposerModes().map((mode) => ({
      value: mode.id,
      label: mode.label,
      description: mode.description,
      glyph: modeGlyph(mode.id),
      selected: mode.id === selected,
    })),
  );
}
