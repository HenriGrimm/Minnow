# Themes

Sixteen composed themes on `<html data-theme="{family}-{mode}">`.

## Families × modes

| Family | Dark | Light | Accent character |
|--------|------|-------|------------------|
| **swamp** (default) | `swamp-dark` | `swamp-light` | Muted green on cool neutrals |
| **desert** | `desert-dark` | `desert-light` | Warm amber on taupe |
| **ocean** | `ocean-dark` | `ocean-light` | Soft cyan on blue-tinted neutrals |
| **coral** | `coral-dark` | `coral-light` | Warm coral on charcoal |
| **mono** | `mono-dark` | `mono-light` | Grayscale only |
| **matrix** | `matrix-dark` | `matrix-light` | Phosphor green on CRT black |
| **human** | `human-dark` | `human-light` | Burnt orange on near-black |
| **mint** | `mint-dark` | `mint-light` | Mint phosphor on cool charcoal |

Default when storage is empty: **`swamp-dark`** ([`DEFAULT_THEME_ID`](../../src/theme.ts)).

Family metadata (names, blurbs): [`THEME_FAMILY_META`](../../src/theme.ts).

## Storage

Canonical file: `~/.minnow/appearance.json` (`GET`/`PUT /api/config/appearance`). `localStorage` is a first-paint cache and Vite-only fallback.

| Key | Purpose |
|-----|---------|
| `minnow.theme` | Explicit `ThemeId` when not following OS |
| `minnow.theme.followSystem` | `'1'` when mode tracks `prefers-color-scheme` |
| `minnow.theme.family` | Active family while follow-system is on |

Legacy values (`light`, `dark`, `system`, pre-rename families like `sage`→`swamp`) migrate on read in [`src/theme.ts`](../../src/theme.ts).

## Runtime pipeline

1. **FOUC boot** — inline script in [`index.html`](../../index.html) sets `data-theme` before paint. Served HTML injects `window.__MINNOW_APPEARANCE_BOOT__` from `appearance.json` so a new origin still has the saved palette.
2. **`applyTheme()`** — [`src/theme.ts`](../../src/theme.ts) sets `data-theme`, updates `theme-color` meta, and schedules a write to `appearance.json`.
3. **`hydrateAppearanceFromServer()`** — [`src/appearance/persist.ts`](../../src/appearance/persist.ts) loads the home file after `/api/config` is up (server wins; localStorage migrates if the file was never saved).
4. **`initTheme()`** — [`src/ui/theme.ts`](../../src/ui/theme.ts) wires hljs, xterm, custom tokens, fonts; adds `theme-ready`.
5. **Transitions** — [`theme-transitions.css`](../../src/styles/theme-transitions.css) guards first paint; text-entry controls use `transition: none` (MIN-168 caret + macOS composer glyph lag).

## Custom appearance

| Key | Purpose |
|-----|---------|
| `minnow.appearance.customEnabled` | Inline `--mn-*` overrides active |
| `minnow.appearance.customTokens` | JSON map of 26 core keys → color |
| `minnow.appearance.customAdvanced` | Per-token editor vs simplified seeds |
| `minnow.appearance.fonts` | UI + mono preset or upload refs |

Simplified mode derives full palettes via [`theme-derive.ts`](../../src/appearance/theme-derive.ts). Success is a fixed-hue semantic green (not a copy of accent); warning/folder shift from accent hue; danger comes from the danger seed.

**Agent tools (Electron only):** `get_appearance`, `update_appearance`, `upload_appearance_asset` in [`appearance-tools.ts`](../../src/tools/appearance-tools.ts).

## Downstream consumers

| Consumer | File |
|----------|------|
| CodeMirror | [`codemirror-theme.ts`](../../src/ui/codemirror-theme.ts) |
| xterm PTY | [`terminal-xterm-theme.ts`](../../src/ui/terminal-xterm-theme.ts) |
| Research HTML reports | [`server/research/report-theme.js`](../../server/research/report-theme.js) |
| Settings preview | [`settings-appearance-theme.ts`](../../src/ui/settings-appearance-theme.ts) |

## Adding or editing a theme

1. Add a `:root[data-theme="family-mode"]` block in [`tokens.css`](../../src/styles/tokens.css) with all core `--mn-*` keys.
2. Copy derived tokens (`--mn-selection-bg`, shadows, tool-call, syntax) from an existing block.
3. Add wallpaper tints in [`minnowos-tokens.css`](../../src/styles/minnowos-tokens.css) when the workspace shell uses them.
4. Register family in `THEME_FAMILIES` / `THEME_FAMILY_META` in [`theme.ts`](../../src/theme.ts).
5. Run `test/theme.test.mts` and `test/theme-contrast.test.mts`.
