/**
 * Normalize and serialize Settings → Appearance for ~/.minnow/appearance.json.
 * Theme used to live only in Chromium localStorage, which is origin-scoped —
 * packaged Electron binds a new loopback port per launch, so the choice vanished.
 */

const THEME_FAMILIES = ['swamp', 'desert', 'ocean', 'coral', 'mono', 'matrix', 'human', 'mint'];
const THEME_MODES = ['dark', 'light'];
const THEME_ID_RE = /^(swamp|desert|ocean|coral|mono|matrix|human|mint)-(dark|light)$/;

const CORE_THEME_TOKEN_KEYS = [
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
];

const TOKEN_KEY_SET = new Set(CORE_THEME_TOKEN_KEYS);
const MAX_COLOR_CHARS = 64;
const MAX_FONT_NAME_CHARS = 80;
const MAX_ASSET_ID_CHARS = 128;

const DEFAULT_FONTS = {
  ui: { kind: 'preset', slot: 'ui', id: 'system' },
  mono: { kind: 'preset', slot: 'mono', id: 'system' },
};

/** Empty persisted blob — `updatedAt` null means the file has never been saved. */
export function defaultAppearanceConfig() {
  return {
    version: 1,
    chatView: 'compact',
    followSystem: false,
    family: 'swamp',
    themeId: 'swamp-dark',
    customEnabled: false,
    customAdvanced: false,
    customTokens: {},
    fonts: {
      ui: { ...DEFAULT_FONTS.ui },
      mono: { ...DEFAULT_FONTS.mono },
    },
    updatedAt: null,
  };
}

function isThemeFamily(value) {
  return typeof value === 'string' && THEME_FAMILIES.includes(value);
}

function isThemeId(value) {
  return typeof value === 'string' && THEME_ID_RE.test(value);
}

function familyFromThemeId(themeId) {
  if (!isThemeId(themeId)) return 'swamp';
  return themeId.slice(0, themeId.lastIndexOf('-'));
}

function composeThemeId(family, mode) {
  const fam = isThemeFamily(family) ? family : 'swamp';
  const resolvedMode = THEME_MODES.includes(mode) ? mode : 'dark';
  return `${fam}-${resolvedMode}`;
}

function sanitizeColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, MAX_COLOR_CHARS);
  if (!trimmed) return null;
  // Reject anything that could break out of an inline boot script.
  if (/[<>]/.test(trimmed) || /javascript:/i.test(trimmed)) return null;
  return trimmed;
}

function normalizeCustomTokens(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!TOKEN_KEY_SET.has(key)) continue;
    const color = sanitizeColor(value);
    if (color) out[key] = color;
  }
  return out;
}

function normalizeFontRef(raw, slot) {
  const fallback = slot === 'ui' ? { ...DEFAULT_FONTS.ui } : { ...DEFAULT_FONTS.mono };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const kind = raw.kind === 'upload' ? 'upload' : 'preset';
  if (kind === 'upload') {
    const assetId = typeof raw.assetId === 'string' ? raw.assetId.trim().slice(0, MAX_ASSET_ID_CHARS) : '';
    const familyName =
      typeof raw.familyName === 'string' ? raw.familyName.trim().slice(0, MAX_FONT_NAME_CHARS) : '';
    if (!assetId || /[<>]/.test(assetId) || /[<>]/.test(familyName)) return fallback;
    return {
      kind: 'upload',
      slot,
      assetId,
      familyName: familyName || `MinnowCustom${slot}`,
    };
  }
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 64) : 'system';
  if (!id || /[<>]/.test(id)) return fallback;
  return { kind: 'preset', slot, id };
}

function normalizeFonts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ui: { ...DEFAULT_FONTS.ui }, mono: { ...DEFAULT_FONTS.mono } };
  }
  return {
    ui: normalizeFontRef(raw.ui, 'ui'),
    mono: normalizeFontRef(raw.mono, 'mono'),
  };
}

/**
 * Coerce an API/disk payload into a safe appearance blob.
 * @param {unknown} raw
 */
export function normalizeAppearanceConfig(raw) {
  const base = defaultAppearanceConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const row = /** @type {Record<string, unknown>} */ (raw);

  const followSystem = row.followSystem === true;
  const rawThemeId = isThemeId(/** @type {string} */ (row.themeId))
    ? /** @type {string} */ (row.themeId)
    : null;
  const rawFamily = isThemeFamily(/** @type {string} */ (row.family))
    ? /** @type {string} */ (row.family)
    : null;

  // Explicit theme id wins when not following the OS; family wins when following.
  let family = 'swamp';
  let themeId = 'swamp-dark';
  if (followSystem) {
    family = rawFamily ?? (rawThemeId ? familyFromThemeId(rawThemeId) : 'swamp');
    const mode = rawThemeId && rawThemeId.endsWith('-light') ? 'light' : 'dark';
    themeId = composeThemeId(family, mode);
  } else if (rawThemeId) {
    themeId = rawThemeId;
    family = familyFromThemeId(rawThemeId);
  } else if (rawFamily) {
    family = rawFamily;
    themeId = composeThemeId(family, 'dark');
  }

  const updatedAt = typeof row.updatedAt === 'string' && row.updatedAt.trim() ? row.updatedAt.trim() : null;

  return {
    version: 1,
    followSystem,
    family,
    themeId,
    chatView: row.chatView === 'full' ? 'full' : 'compact',
    customEnabled: row.customEnabled === true,
    customAdvanced: row.customAdvanced === true,
    customTokens: normalizeCustomTokens(row.customTokens),
    fonts: normalizeFonts(row.fonts),
    updatedAt,
  };
}

/** True when the blob is still the never-saved default (do not clobber localStorage). */
export function isUnpersistedAppearance(state) {
  return !state || state.updatedAt == null;
}

/** True when disk/API state should win over an empty Chromium origin. */
export function appearanceLooksPersisted(state) {
  if (!state) return false;
  if (state.chatView === 'full') return true;
  if (state.updatedAt) return true;
  if (state.followSystem) return true;
  if (state.themeId && state.themeId !== 'swamp-dark') return true;
  if (state.family && state.family !== 'swamp') return true;
  if (state.customEnabled) return true;
  if (state.customTokens && Object.keys(state.customTokens).length > 0) return true;
  const fonts = state.fonts;
  if (fonts?.ui && (fonts.ui.kind !== 'preset' || fonts.ui.id !== 'system')) return true;
  if (fonts?.mono && (fonts.mono.kind !== 'preset' || fonts.mono.id !== 'system')) return true;
  return false;
}

/**
 * Compact FOUC payload injected into index.html before the boot theme script.
 * @param {ReturnType<typeof normalizeAppearanceConfig>} state
 */
export function appearanceBootPayload(state) {
  const normalized = normalizeAppearanceConfig(state);
  return {
    followSystem: normalized.followSystem,
    chatView: normalized.chatView,
    family: normalized.family,
    themeId: normalized.themeId,
    customEnabled: normalized.customEnabled,
    customAdvanced: normalized.customAdvanced,
    customTokens: normalized.customTokens,
    fonts: normalized.fonts,
  };
}

/**
 * Insert the boot payload as the first script in <head> so FOUC can seed localStorage.
 * @param {string} html
 * @param {unknown} payload
 */
export function injectAppearanceBootScript(html, payload) {
  if (!payload || typeof html !== 'string' || !html) return html;
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const script = `<script>window.__MINNOW_APPEARANCE_BOOT__=${json};</script>`;
  const marker = '<head>';
  const idx = html.indexOf(marker);
  if (idx === -1) return script + html;
  return html.slice(0, idx + marker.length) + script + html.slice(idx + marker.length);
}
