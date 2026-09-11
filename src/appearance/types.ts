/**
 * Appearance customization types — custom palette tokens, fonts, and asset refs.
 */

/** Core Minnow CSS variable names (without --mn- prefix in storage). */
export const CORE_THEME_TOKEN_KEYS = [
  'bg',
  'surface-0',
  'surface-1',
  'surface-2',
  'border',
  'border-strong',
  'fg',
  'fg-muted',
  'fg-subtle',
  'fg-on-accent',
  'accent',
  'accent-soft',
  'accent-border',
  'accent-ink',
  'success',
  'success-soft',
  'success-border',
  'success-ink',
  'warning',
  'danger',
  'danger-soft',
  'danger-border',
  'danger-ink',
  'focus-ring',
  'shadow',
  'folder',
] as const;

export type CoreThemeTokenKey = (typeof CORE_THEME_TOKEN_KEYS)[number];

/** Map of token key → CSS color value (hex or rgba). */
export type CustomThemeTokens = Partial<Record<CoreThemeTokenKey, string>>;

export const APPEARANCE_STORAGE_KEYS = {
  chatView: 'minnow.appearance.chatView',
  customEnabled: 'minnow.appearance.customEnabled',
  customTokens: 'minnow.appearance.customTokens',
  /** `'1'` when the full per-token editor is active (vs simplified seeds). */
  customAdvanced: 'minnow.appearance.customAdvanced',
  fonts: 'minnow.appearance.fonts',
} as const;

import type { MonoFontPresetId, UiFontPresetId } from './font-catalog';

export {
  MONO_FONT_PRESETS,
  UI_FONT_PRESETS,
  type MonoFontPresetId,
  type UiFontPresetId,
} from './font-catalog';

export type FontPresetRef =
  | { kind: 'preset'; slot: 'ui'; id: UiFontPresetId }
  | { kind: 'preset'; slot: 'mono'; id: MonoFontPresetId };

export type FontUploadRef = {
  kind: 'upload';
  slot: 'ui' | 'mono';
  assetId: string;
  familyName: string;
};

export type FontRef = FontPresetRef | FontUploadRef;

export interface AppearanceFonts {
  ui: FontRef;
  mono: FontRef;
}

export const DEFAULT_APPEARANCE_FONTS: AppearanceFonts = {
  ui: { kind: 'preset', slot: 'ui', id: 'system' },
  mono: { kind: 'preset', slot: 'mono', id: 'system' },
};

/** IndexedDB asset kinds for appearance uploads. */
export type AppearanceAssetKind = 'font';

export interface AppearanceAssetRecord {
  id: string;
  kind: AppearanceAssetKind;
  mimeType: string;
  name: string;
  blob: Blob;
  createdAt: string;
}

/** UI grouping for custom color pickers in settings. */
export interface ThemeTokenGroup {
  id: string;
  label: string;
  keys: CoreThemeTokenKey[];
}

export const THEME_TOKEN_GROUPS: ThemeTokenGroup[] = [
  {
    id: 'surfaces',
    label: 'Surfaces',
    keys: ['bg', 'surface-0', 'surface-1', 'surface-2', 'border', 'border-strong', 'shadow'],
  },
  {
    id: 'text',
    label: 'Text',
    keys: ['fg', 'fg-muted', 'fg-subtle', 'fg-on-accent'],
  },
  {
    id: 'accent',
    label: 'Accent',
    keys: ['accent', 'accent-soft', 'accent-border', 'accent-ink', 'focus-ring'],
  },
  {
    id: 'semantic',
    label: 'Semantic',
    keys: [
      'success',
      'success-soft',
      'success-border',
      'success-ink',
      'warning',
      'danger',
      'danger-soft',
      'danger-border',
      'danger-ink',
      'folder',
    ],
  },
];

/** Convert storage key to CSS variable name. */
export function tokenKeyToCssVar(key: CoreThemeTokenKey): `--mn-${CoreThemeTokenKey}` {
  return `--mn-${key}` as `--mn-${CoreThemeTokenKey}`;
}
