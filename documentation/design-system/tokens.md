# Design tokens

All palette values live in [`src/styles/tokens.css`](../../src/styles/tokens.css). Every other stylesheet consumes **`--mn-*`** variables (never raw hex outside `tokens.css`).

## Core palette (`--mn-*`)

26 keys defined in [`CORE_THEME_TOKEN_KEYS`](../../src/appearance/types.ts). Customizable via Settings → Appearance or agent `update_appearance`.

| Token | Role |
|-------|------|
| `--mn-bg` | Page / shell background |
| `--mn-surface-0` … `--mn-surface-2` | Layered surfaces (inputs, panels, elevated rows) |
| `--mn-border`, `--mn-border-strong` | Hairlines and emphasized dividers |
| `--mn-fg`, `--mn-fg-muted`, `--mn-fg-subtle` | Primary, secondary, tertiary text |
| `--mn-fg-on-accent` | Text/icons on filled accent buttons |
| `--mn-accent`, `--mn-accent-soft`, `--mn-accent-border`, `--mn-accent-ink` | Primary brand action color (varies per theme family) |
| `--mn-success` (+ soft, border, ink) | Metric green, ok status |
| `--mn-warning` | Metric amber, prompt token bars |
| `--mn-danger` (+ soft, border, ink) | Errors, destructive hover |
| `--mn-focus-ring` | `:focus-visible` outline |
| `--mn-shadow` | Shadow color base (mobile sidebar, popovers) |
| `--mn-folder` | File-tree folder tint |

## Derived per theme (not in custom editor)

Set in each `data-theme` block; built with `color-mix` where noted.

| Token | Role |
|-------|------|
| `--mn-warning-soft`, `--mn-warning-border` | Warning banners, chips |
| `--mn-overlay` | Drawer / mobile sidebar scrim |
| `--mn-surface-elevated` | Row hover veil |
| `--mn-selection-bg` | Text selection, CodeMirror, xterm |
| `--mn-syntax-command`, `--mn-syntax-name`, `--mn-syntax-inline`, `--mn-syntax-link` | Slash picker, inline code, links |

## Feature-specific (per theme block)

| Token | Role |
|-------|------|
| `--asst-bg`, `--asst-bdr` | Assistant message bubble |
| `--shadow-popover`, `--shadow-sidebar`, `--shadow-drawer`, … | Elevation vocabulary |
| `--tool-call-*` | Tool invocation panels in chat |
| `--thought-bubble-bg`, `--thought-flow-bg`, `--thought-segment-bg` | Thinking UI |
| `--banner-danger-*`, `--settings-warn-banner-*` | Inline warnings |
| `--cm-keyword`, `--cm-title`, `--cm-attr`, `--cm-string` | CodeMirror syntax |

## Layout and motion (`:root`)

Not theme-specific; shared across all palettes.

```css
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--duration-fast: 0.15s;
--duration-normal: 0.22s;
--duration-slow: 0.35s;
--font-ui: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
--font-mono: 'JetBrains Mono', ui-monospace, monospace;
--bp-compact: 600px;
--bp-mobile: 640px;
--bp-wide: 900px;
--topbar-h: 52px;
--sidebar-w: 300px;
--sidebar-rail: 48px;
--file-sidebar-w: 350px;
--file-sidebar-rail: 48px;
--viewer-min-w: 280px;
--split-ratio: 0.55;
--touch-min: 44px;
--chat-msg-max: 1024px;
--chat-composer-max: calc(var(--chat-msg-max) + 40px);
--chat-msg-md-ch: 88ch;
--chat-tool-call-max: 520px;
```

## Scale tokens (`:root`)

Theme-independent scales. Application CSS uses these instead of literals; [`DESIGN.md`](../../DESIGN.md) gives the usage rules and literal-to-token mapping.

| Group | Tokens |
|-------|--------|
| Type size | `--mn-type-2xs` 10px, `-xs` 11px, `-sm` 12px, `-md` 13px, `-base` 14px, `-lg` 15px, `-xl` 16px, `-2xl` 18px, `-3xl` 20px, `-4xl` 24px, `-display` 28px |
| Line height | `--mn-leading-none` 1, `-tight` 1.2, `-snug` 1.35, `-normal` 1.5, `-relaxed` 1.6 |
| Weight | `--mn-weight-regular` 400, `-medium` 500, `-semibold` 600 |
| Tracking | `--mn-tracking-title` -0.02em, `--mn-tracking-label` 0.06em |
| Spacing | `--mn-space-0-5` 2px, `-1` 4px, `-1-5` 6px, `-2` 8px, `-2-5` 10px, `-3` 12px, `-3-5` 14px, `-4` 16px, `-5` 20px, `-6` 24px, `-7` 28px, `-8` 32px, `-10` 40px, `-12` 48px |
| Radius | `--mn-radius-xs` 4px, `-sm` 6px, `-md` 10px, `-lg` 14px, `-xl` 20px, `-pill` 999px (legacy `--radius-sm/md/lg` alias the same values) |
| Controls | `--mn-control-h-sm` 28px, `-md` 32px, `-lg` 40px; `--mn-control-px-sm/md/lg` 8/12/16px; `--mn-control-gap` 6px |
| Icons | `--mn-icon-sm` 14px, `-md` 16px, `-lg` 18px (`--mn-icon-size` stays the per-element override) |
| Focus | `--mn-focus-ring-width` 2px, `--mn-focus-ring-offset` 2px |
| Layers | `--mn-z-raised` 1, `-sticky` 20, `-shell` 50, `-capture` 95, `-menu` 96, `-toast` 100025, `-dialog` 100030, `-popover` 100040, `-tooltip` 100050 |

`--mn-text-*` names (`--mn-text-muted`, `--mn-text-hover`, …) are colour aliases in older stylesheets, which is why the type scale uses `--mn-type-*`.

## Typography presets

`--font-ui` and `--font-mono` are the only font-family tokens. Stylesheets must use those names — `--mn-font-mono` is not defined, so `var(--mn-font-mono, …)` ignores the user's Appearance → Fonts choice.

Font stacks override via [`src/appearance/fonts.ts`](../../src/appearance/fonts.ts):

- **UI:** `system` plus 30+ Google Sans families (lazy-loaded) and an upload slot. Catalog: [`src/appearance/font-catalog.ts`](../../src/appearance/font-catalog.ts).
- **Mono:** `system` (JetBrains-led stack) plus 20+ Google Mono families including Fira Code, JetBrains Mono, and Cascadia Code (+ upload).

Hierarchy (from DESIGN.md, implemented in CSS):

| Step | Size | Weight | Use |
|------|------|--------|-----|
| Title | `--mn-type-lg` 15px | 600 | Top bar title, drawer headers |
| Body | `--mn-type-base` 14px | 400 | Messages, inputs, settings |
| Control | `--mn-type-md` 13px | 500 | Buttons, menus, list rows |
| Label | `--mn-type-xs` 11px | 600 uppercase | Sidebar sections, stat names |
| Caption | `--mn-type-2xs`–`--mn-type-sm` 10–12px | 500 | Model id, hints, chips |
| Mono stat | `--mn-type-2xl` 18px | 600 tabular-nums | Stats strip values |

## Named rules

**Ink accent rule.** Accent fills primary actions (send, active row border, links). It does not wash large backgrounds except logo mark and send button.

**Metric color rule.** Success/warning/danger are for TPS, TTFT, tokens, errors only.

**72ch rule.** Assistant markdown caps at `min(720px, 72ch)` (`--chat-msg-md-ch` is 88ch for Code workspace).

**Flat chrome rule.** Chrome surfaces do not use box-shadow at rest.
