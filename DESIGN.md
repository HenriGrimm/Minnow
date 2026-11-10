---
name: Minnow
description: Graphite workspace with nine dark and light palette families, surface tint, and a shared type and spacing scale.
colors:
  bg: "#0f1216"
  surface-0: "#0b0d11"
  surface-1: "#161a20"
  surface-2: "#1f242b"
  border: "rgba(255,255,255,0.06)"
  border-strong: "rgba(255,255,255,0.12)"
  fg: "#dfe3e8"
  fg-muted: "#8a929c"
  fg-subtle: "#5a626c"
  fg-on-accent: "#0b1410"
  accent: "#9ec5a7"
  accent-soft: "rgba(158,197,167,0.14)"
  accent-border: "rgba(158,197,167,0.28)"
  accent-ink: "#cfe5d4"
  success: "#9ec5a7"
  warning: "#d4a574"
  danger: "#e07a6f"
  focus-ring: "#9ec5a7"
typography:
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  control:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.2
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0.06em"
  caption:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  keyHint:
    fontFamily: "'Geist Mono', ui-monospace, monospace"
    fontSize: "10.5px"
  compactMono:
    fontFamily: "'Geist Mono', ui-monospace, monospace"
    fontSize: "11.5px"
  toolbar:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "12.5px"
  sheetTitle:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "13.5px"
  reading:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "14.5px"
  sectionTitle:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "16px"
  stageTitle:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "20px"
  startTitle:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "26px"
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "20px"
  pill: "999px"
  graphiteControl: "7px"
  graphiteSelection: "8px"
  graphiteGroup: "9px"
  graphiteSheet: "12px"
  graphiteComposer: "16px"
  graphitePhoneSheet: "18px"
spacing:
  0-5: "2px"
  1: "4px"
  1-5: "6px"
  2: "8px"
  2-5: "10px"
  3: "12px"
  3-5: "14px"
  4: "16px"
  5: "20px"
  6: "24px"
  7: "28px"
  8: "32px"
  10: "40px"
  12: "48px"
  control-h-sm: "28px"
  control-h-md: "32px"
  control-h-lg: "40px"
  topbar-h: "52px"
  sidebar-w: "300px"
  sidebar-rail: "48px"
  touch-min: "44px"
components:
  button-secondary:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    height: "32px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.fg-on-accent}"
    rounded: "{rounded.sm}"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "color-mix(in srgb, {colors.fg} 10%, transparent)"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    height: "32px"
---

# Design System: Minnow

## Palette themes

`<html data-theme="{family}-{mode}">` (e.g. `swamp-dark`, `coral-light`) is set from **Settings → Appearance → Theme**, the inline boot script in `index.html`, or `initTheme()` in [`src/theme.ts`](src/theme.ts). The families are **Graphite**, **Swamp**, **Desert**, **Ocean**, **Coral**, **Mono**, **Matrix**, **Human**, and **Mint**. Each has dark and light variants. Hex and rgba literals exist only in [`src/styles/tokens.css`](src/styles/tokens.css); application CSS uses **`--mn-*`** tokens (26 core variables in [`CORE_THEME_TOKEN_KEYS`](src/appearance/types.ts) plus extended semantics via `color-mix`). Extracted inventory: [`documentation/design-system/`](documentation/design-system/README.md).

Storage uses `minnow.theme`, `minnow.theme.followSystem` and `minnow.theme.family`. New profiles start with **Graphite** and **Subtle** color. Saved families, custom colors, font overrides and older aliases migrate on read. Graphite uses bundled Geist and Geist Mono by default.

## Overview

Source Control uses a local type scale on `.scc-root`. PR inspector titles use `--scc-title-xl` (24px), reducing to `--scc-title-compact` (21px) in narrow windows. List titles and Markdown stay at the 14px body baseline; metadata uses the existing 11–13px label steps. Titles provide hierarchy without enlarging the surrounding controls.

**Creative North Star: "Calm local instrument"**

Minnow is a long-session chat bench: conversation first, metrics as instrumentation, borders instead of card stacks. Palette families change mood (swamp, desert, ocean, coral, mono, matrix, human, mint) without neon HUD chrome, hero metric templates, glassmorphism, or gradient text.

**Key Characteristics:**

- Off-black / off-white surfaces per family (never pure `#000` / `#fff` in palette blocks).
- Family accent on send, selection, links, and user bubbles (`--mn-accent-soft`; text selection uses `--mn-selection-bg`, including CodeMirror `drawSelection` in dark mode).
- Semantic success / warning / danger for stats and tool status only.
- JetBrains Mono for stats, chips, and code by default; system UI at 14px elsewhere. Settings → Appearance can swap either stack from a Google Fonts catalog (lazy-loaded).
- Flat elevation: shadows use `var(--mn-shadow)`; hover veils use `color-mix` on `--mn-fg`.

## Colors

Palette is **family-dependent**. The YAML colors record the legacy Swamp token roles. Workspace chrome uses the `--mn-graphite-*` roles in `tokens.css` for its ground, sheet, raised surfaces, text and edges. Color intensity affects those surfaces, navigation selection, and the user bubble. Diff, warning and syntax colors use separate roles.

### Primary (accent family)

- **`--mn-accent`**: Send button, active chat row border, streaming cursor, focus outlines, markdown links. Varies per family (e.g. swamp green `#9ec5a7`, mono near-white, matrix phosphor).
- **`--mn-accent-ink`**: High-contrast accent text on syntax and badges.

### Secondary

- **`--mn-accent-soft`**: User message bubble background (`messages.css`). Keeps the thread readable without a second brand color fighting the accent.

### Tertiary (metrics only)

- **`--mn-success`**, **`--mn-warning`**, **`--mn-danger`**: Stats strip, stat chips (`.c` / `.g` / `.y` / `.r`), status dots, token fill bars. Never navigation chrome or decorative gradients.

### Neutrals

- **`--mn-bg`**: Ground behind the workbench and recessed canvases such as the Brain graph.
- **`--mn-surface-0`**: Workbench sheet, including its navigation rail, toolbar, and docked terminal.
- **`--mn-surface-1`**, **`--mn-surface-2`**: Raised controls, cards, and floating panels.
- **`--mn-fg`**, **`--mn-fg-muted`**, **`--mn-fg-subtle`**: Body, labels, placeholders.
- **`--mn-border`**, **`--mn-border-strong`**: Dividers, assistant bubble outline, table cells.
- **`--mn-surface-elevated`**, **`--mn-sel`**: Hover and navigation selection veils.
- **`--mn-overlay`**: Settings drawer and mobile sidebar scrim.

### Named Rules

**The Accent Rule.** Family accent appears on primary actions, selection, and links. It does not wash large backgrounds except logo mark and send button.

**The Metric Color Rule.** Success, warning, and danger are for measurement only (TPS, TTFT, tokens, errors). Never use them for navigation chrome or decorative gradients.

## Dropdowns and menus

Dropdown panels use `--mn-menu-*` tokens: 14px panel corners, 10px inset row
corners, 6px panel padding, and a shared opaque surface and shadow. Native selects
and custom menus share this treatment; see
[`documentation/design-system/dropdowns.md`](documentation/design-system/dropdowns.md)
for component usage and accessibility rules.

## Typography

**Display Font:** Not used (product UI, no marketing hero type).

**Body Font:** `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` (14px base, line-height 1.5).

**Label/Mono Font:** JetBrains Mono (400–600) by default for stats strip, per-message chips, token counts, fenced code, and field hints that reference code. Appearance → Fonts can substitute another Google Mono family; only the selected pair is requested.

**Character:** Calm technical sans for UI; mono carries numeric instrumentation. No display serif or geometric marketing face.

### Hierarchy

- **Title** (600, 15px, -0.02em tracking): App title in top bar, drawer header.
- **Body** (400, 14px, 1.5): Messages, inputs, drawer fields, chat list names.
- **Label** (600, 11px, 0.06em uppercase): Sidebar "Chats", stats expand label, stat cell names.
- **Caption** (500, 9–12px): Session model id, sidebar stats line, stat chips, field hints.
- **Mono stat** (600, 17px tabular-nums): Stats strip values; chips at 9px uppercase with bold inner span.

### Type scale

Font sizes come from `--mn-type-*` in [`tokens.css`](src/styles/tokens.css). (`--mn-text-*` names are colour aliases, not sizes.)

| Token | Size | Typical use |
|-------|------|-------------|
| `--mn-type-2xs` | 10px | Stat chips, dense metadata |
| `--mn-type-xs` | 11px | Labels, uppercase section heads |
| `--mn-type-sm` | 12px | Captions, hints, tooltips, small controls |
| `--mn-type-md` | 13px | Controls, menus, list rows |
| `--mn-type-base` | 14px | Body, messages, inputs |
| `--mn-type-lg` | 15px | Titles, drawer headers |
| `--mn-type-xl` | 16px | Section titles; touch inputs (avoids iOS zoom) |
| `--mn-type-2xl` | 18px | Panel titles, stats strip values |
| `--mn-type-3xl` | 20px | Page titles |
| `--mn-type-4xl` | 24px | Inspector titles |
| `--mn-type-display` | 28px | Empty states, onboarding |

Line heights: `--mn-leading-none` 1 (icon controls), `-tight` 1.2 (controls, titles), `-snug` 1.35, `-normal` 1.5 (body), `-relaxed` 1.6 (long prose). Weights: `--mn-weight-regular` 400, `-medium` 500, `-semibold` 600; nothing else. Tracking: `--mn-tracking-title` -0.02em, `--mn-tracking-label` 0.06em (uppercase labels).

When replacing a literal, half-pixel sizes round up to the next step and rem sizes map to their pixel step (0.75rem → `sm`).

### Named Rules

**The 72ch Rule.** Assistant markdown bubbles cap at `min(720px, 72ch)` for readable line length. User bubbles use full width of the column with pre-wrap.

## Elevation

Flat-by-default. Surfaces share `--surface` / `--bg`; separation is borders, not cards.

### Shadow Vocabulary

- **Mobile sidebar** (`box-shadow: 4px 0 24px oklch(0.1 0.02 250 / 0.4)`): Only when the session list is a fixed overlay (≤640px).
- **Focus rings**: `outline: 2px solid var(--accent)`; inputs also set `border-color: var(--accent)` (`--accent-dim` is transparent, so no glow ring).
- **Code / table lift**: Inline code `oklch(0.94 0.015 250)`; fenced `pre` and table headers `oklch(0.96–0.97 0.01–0.012 250)` on the light page.

### Named Rules

**The Flat Chrome Rule.** Top bar, sidebar, input bar, and stats strip do not use box-shadow at rest. If it looks like a floating SaaS card, remove the shadow.

## Spacing, radius, controls and layers

- **Spacing** uses `--mn-space-*` on a 4px grid with half steps: `-0-5` 2px, `-1` 4px, `-1-5` 6px, `-2` 8px, `-2-5` 10px, `-3` 12px, `-3-5` 14px, `-4` 16px, `-5` 20px, `-6` 24px, `-7` 28px, `-8` 32px, `-10` 40px, `-12` 48px. Odd pixel values snap to the nearest step; 1px is for hairline borders only.
- **Radius** uses `--mn-radius-xs` 4px, `-sm` 6px (controls), `-md` 10px (cards, composer, menu rows), `-lg` 14px (menus, panels), `-xl` 20px, `-pill` 999px. `--radius-sm/md/lg` are legacy aliases of the same values.
- **Control heights** are `--mn-control-h-sm` 28px, `-md` 32px (default), `-lg` 40px, with padding `--mn-control-px-*` and icon-to-label gap `--mn-control-gap`. Under `(pointer: coarse)` every control grows to `--touch-min` (44px).
- **Icons** are `--mn-icon-sm` 14px, `-md` 16px, `-lg` 18px.
- **Focus** rings are `--mn-focus-ring-width` (2px) of `--mn-focus-ring` at `--mn-focus-ring-offset` (2px).
- **Layers** are named, never numbered: `--mn-z-raised`, `-sticky`, `-shell`, `-capture`, `-menu`, `-toast`, `-dialog`, `-popover`, `-tooltip` (lowest to highest). Popovers and tooltips sit above dialogs so they work inside one.

## Components

Controls come from the shared library in [`src/ui/components/`](src/ui/components/) (import from `src/ui/components/index.ts`). Each component is a TypeScript factory that returns a real element and loads its own stylesheet from `src/styles/components/`. Reference: [`documentation/design-system/components.md`](documentation/design-system/components.md). Gallery: `test/fixtures/components-gallery.html` under the Vite dev server.

### Buttons

- **Factories:** `createButton()` and `createIconButton()`. Variants: `secondary` (default), `primary`, `ghost`, `danger`. Sizes: `sm` 28px, `md` 32px (default), `lg` 40px.
- **Shape:** `--mn-radius-sm`; 1px border; `--mn-type-md` medium weight.
- **Secondary:** `--mn-bg` fill and a `--mn-border-strong` hairline (the plain `--mn-border` is too faint to tell it from ghost on dark themes); fine-pointer hover tints toward `--mn-fg` and strengthens the border. Inputs use the same edge.
- **Primary:** `--mn-accent` fill with `--mn-fg-on-accent` text. One per view region. Hover (16%) and press (20%) shift the fill toward black or white, never toward the label: light themes move away from the label colour, and dark themes darken pale accents and lighten mid-tone ones. The label stays at 4.5:1 or better in every theme.
- **Ghost:** transparent until hover (`--mn-surface-elevated`). Toolbars and icon actions.
- **Danger:** `--mn-danger` mixed 65% into `--mn-fg` for text (raw danger is about 4:1 on light themes); hover adds the danger-soft fill and border.
- **Icon button:** square at the control height; the label is required and becomes the accessible name and tooltip.
- **Pressed toggles** (`aria-pressed="true"`) use `--mn-accent-soft` fill and `--mn-accent-border`.
- **Send:** a large primary icon button; 44px under coarse pointers.

### Chips

- **Style:** 9px uppercase, 1px border `--border-strong`, text `--text-dim`.
- **Semantic variants:** `.c` accent, `.g` success, `.y` warning, `.r` danger with matching border alpha tints.
- **Issue labels:** ten catalog swatches (`--mn-label-*` in [`tokens.css`](src/styles/tokens.css)), tinted into `--mn-bg` / `--mn-fg` on `.issues-label[data-swatch]`. Not metric success/warning/danger.

### Issues list

- **Columns:** ID, priority, type, title, labels, then metadata and status. Priority is an identity field, not a trailing chip.
- **Width:** title takes leftover space (`1fr`). Labels are `max-content`: up to three chips, then a caret for the rest, with **+** hugging the last chip.
- **Density:** `--issues-row-h: 36px` with 8px vertical padding; `--issues-list-head-h: 32px`. Compact (≤900px container) keeps ID, priority, title, status.
- **Details:** a centered floating panel (up to 1120px wide) over a dim scrim, with a maximized-size toggle and straight previous/next arrows. Identity, title, activity, and tabs stay pinned. At panel widths of 780px and above, description and comments sit beside a 256px action/properties/resources rail; narrower containers stack these sections. The rail groups model, worktree, and chat controls under Work on this issue, followed by compact property triggers using Minnow's shared styled menus. Escape or the scrim closes the panel and restores list focus.

### Cards / Containers

- **Chat transcript:** one centered reading column, right-aligned user bubbles on `--mn-surface-2`, and unboxed assistant prose. Compact view groups activity behind a Working/Worked disclosure with a thin bottom rule; Full keeps activity open. Per-turn file changes sit below the final answer in a single bordered summary with inline diff review.
- **Session row:** Transparent default; hover `--surface-elevated` + border; active black border + transparent `--accent-dim` fill.
- **No nested cards** in chat or settings.

### Inputs / Fields

- **Style:** `--bg` fill, 1px `--border`, `--radius-sm`, 14px UI font.
- **Focus:** Border `--accent`; `box-shadow: 0 0 0 3px var(--accent-dim)` (dim token is transparent in current theme, so border carries focus).
- **Composer:** `#msgInput` min-height 44px (16px font on compact ≤600px to avoid iOS zoom).

### Navigation

- **Top bar:** 52px, border-bottom, model select embedded with custom chevron.
- **Session sidebar:** 300px (`--sidebar-w`) / 48px rail; mobile overlay with scrim at ≤640px.
- **Settings drawer:** Right sheet `min(420px, 100vw - 16px)`, slide-in 0.22s `--ease-out`.

### Stats strip (signature)

- **Desktop:** Grid of metric cells with mono values and small SVG icons tinted by semantic class.
- **Compact (≤600px):** Collapsed "Metrics" row; tap expands `.stats-strip.is-expanded`.
- **Token bars:** 6px track `--border`; fills use warning (prompt) and success (completion).

## Do's and Don'ts

### Do:

- **Do** use `--mn-*` tokens from [`tokens.css`](src/styles/tokens.css); keep legacy aliases (`--cyan` → `--accent`) when touching older rules.
- **Do** build controls from [`src/ui/components/`](src/ui/components/) and size type, space, radius and layers from the scale tokens instead of literals.
- **Do** respect `prefers-reduced-motion` and limit transitions to color, border, opacity, and transform (not layout).
- **Do** use `(hover: hover) and (pointer: fine)` for hover-heavy styles; keep 44px touch targets on session actions.
- **Do** treat stats as instrumentation: mono, tabular nums, compact chips.

### Don't:

- **Don't** use neon cyber HUD patterns (scanlines, glowing dots, Rajdhani wordmarks).
- **Don't** mimic generic ChatGPT clones (cream cards, purple gradients).
- **Don't** build hero-metric dashboards (giant KPI cards with colored top stripes).
- **Don't** use glassmorphism or gradient text (`background-clip: text`).
- **Don't** add colored `border-left` stripes on cards or alerts.
- **Do** keep `theme-color` meta in sync with effective `--bg` (see `initTheme` / `applyResolvedTheme` in [`src/ui/theme.ts`](src/ui/theme.ts)); PWA manifest defaults remain light.
