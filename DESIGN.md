---
name: Minnow
description: Multi-family palette themes (8× dark/light) on --mn-* tokens; swamp-dark default; family accent, semantic metric colors, flat chrome.
colors:
  bg: "oklch(100% 0.00011 271.152)"
  surface: "oklch(100% 0.00011 271.152)"
  surface-elevated: "oklch(0% 0 0 / 0.84)"
  border: "oklch(28.094% 0.00003 271.152)"
  border-strong: "oklch(0.34 0.028 250)"
  text: "oklch(31.714% 0.00004 271.152)"
  text-muted: "oklch(0.52 0.028 250)"
  text-hover: "oklch(100% 0.00011 271.152)"
  accent: "oklch(0% 0 0)"
  accent-subtle: "oklch(27.685% 0.00003 271.152)"
  success: "oklch(0.72 0.14 155)"
  warning: "oklch(0.8 0.12 85)"
  danger: "oklch(0.62 0.18 15)"
  overlay: "oklch(0.12 0.02 250 / 0.65)"
  user-bg: "oklch(88.769% 0.2563 138.508 / 0.336)"
  user-bdr: "oklch(0.72 0.12 220 / 0.28)"
  code-bg: "oklch(0.97 0.012 250)"
  code-inline-bg: "oklch(0.94 0.015 250)"
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
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.06em"
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
spacing:
  topbar-h: "52px"
  sidebar-w: "300px"
  sidebar-rail: "48px"
  touch-min: "44px"
components:
  send-btn:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text-hover}"
    rounded: "{rounded.md}"
    size: "44px"
  icon-btn:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    size: "40px"
  icon-btn-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    rounded: "{rounded.sm}"
---

# Design System: Minnow

## Palette themes

`<html data-theme="{family}-{mode}">` (e.g. `swamp-dark`, `coral-light`) is set from **Settings → Appearance → Theme**, the inline boot script in `index.html`, or `initTheme()` in [`src/theme.ts`](src/theme.ts). Eight families: **Swamp**, **Desert**, **Ocean**, **Coral**, **Mono** (grayscale), **Matrix** (phosphor green), **Human**, **Mint**, each with dark and light variants. Default: **swamp-dark**. Hex and rgba literals exist only in [`src/styles/tokens.css`](src/styles/tokens.css); application CSS uses **`--mn-*`** tokens (26 core variables in [`CORE_THEME_TOKEN_KEYS`](src/appearance/types.ts) plus extended semantics via `color-mix`). Extracted inventory: [`documentation/design-system/`](documentation/design-system/README.md).

Storage: `minnow.theme` (explicit id), `minnow.theme.followSystem`, `minnow.theme.family`. Default theme: **swamp-dark**. Legacy `light` / `dark` / `system` values and pre-rename family ids (e.g. `sage`→`swamp`) migrate on read.

## Overview

**Creative North Star: "Calm local instrument"**

Minnow is a long-session chat bench: conversation first, metrics as instrumentation, borders instead of card stacks. Palette families change mood (swamp, desert, ocean, coral, mono, matrix, human, mint) without neon HUD chrome, hero metric templates, glassmorphism, or gradient text.

**Key Characteristics:**

- Off-black / off-white surfaces per family (never pure `#000` / `#fff` in palette blocks).
- Family accent on send, selection, links, and user bubbles (`--mn-accent-soft`; text selection uses `--mn-selection-bg`, including CodeMirror `drawSelection` in dark mode).
- Semantic success / warning / danger for stats and tool status only.
- JetBrains Mono for stats, chips, and code by default; system UI at 14px elsewhere. Settings → Appearance can swap either stack from a Google Fonts catalog (lazy-loaded).
- Flat elevation: shadows use `var(--mn-shadow)`; hover veils use `color-mix` on `--mn-fg`.

## Colors

Palette is **family-dependent** (hex in `tokens.css`). The YAML frontmatter above documents **swamp-light** as a reference snapshot; other families swap accent and neutrals while keeping the same token roles.

### Primary (accent family)

- **`--mn-accent`**: Send button, active chat row border, streaming cursor, focus outlines, markdown links. Varies per family (e.g. swamp green `#9ec5a7`, mono near-white, matrix phosphor).
- **`--mn-accent-ink`**: High-contrast accent text on syntax and badges.

### Secondary

- **`--mn-accent-soft`**: User message bubble background (`messages.css`). Keeps the thread readable without a second brand color fighting the accent.

### Tertiary (metrics only)

- **`--mn-success`**, **`--mn-warning`**, **`--mn-danger`**: Stats strip, stat chips (`.c` / `.g` / `.y` / `.r`), status dots, token fill bars. Never navigation chrome or decorative gradients.

### Neutrals

- **`--mn-bg`**, **`--mn-surface-*`**: Top bar, sidebar, input bar, stats strip, drawer.
- **`--mn-fg`**, **`--mn-fg-muted`**, **`--mn-fg-subtle`**: Body, labels, placeholders.
- **`--mn-border`**, **`--mn-border-strong`**: Dividers, assistant bubble outline, table cells.
- **`--mn-surface-elevated`**: Sidebar row hover, stats expand hover (`color-mix` on fg).
- **`--mn-overlay`**: Settings drawer and mobile sidebar scrim.

### Named Rules

**The Accent Rule.** Family accent appears on primary actions, selection, and links. It does not wash large backgrounds except logo mark and send button.

**The Metric Color Rule.** Success, warning, and danger are for measurement only (TPS, TTFT, tokens, errors). Never use them for navigation chrome or decorative gradients.

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

## Components

### Buttons

- **Shape:** `--radius-sm` (6px) icon buttons; `--radius-md` (10px) send and message input.
- **Icon button:** 40×40px, transparent, 1px `--border`. Fine-pointer hover: black fill, white stroke (`--text-hover` on label color).
- **Send:** 44×44px black square; icon stroke near-white. Hover: white fill, black border, dark icon stroke, slightly larger icon (27px).
- **New chat (sidebar):** Outlined black border/text; hover fills black with white text.
- **Drawer clear:** Ghost border; hover border and text `--danger`.

### Chips

- **Style:** 9px uppercase, 1px border `--border-strong`, text `--text-dim`.
- **Semantic variants:** `.c` accent, `.g` success, `.y` warning, `.r` danger with matching border alpha tints.
- **Issue labels:** ten catalog swatches (`--mn-label-*` in [`tokens.css`](src/styles/tokens.css)), tinted into `--mn-bg` / `--mn-fg` on `.issues-label[data-swatch]`. Not metric success/warning/danger.

### Issues list

- **Columns:** ID, priority, type, title, labels, then metadata and status. Priority is an identity field, not a trailing chip.
- **Width:** title takes leftover space (`1fr`). Labels are `max-content`: up to three chips, then a caret for the rest, with **+** hugging the last chip.
- **Density:** `--issues-row-h: 36px` with 8px vertical padding; `--issues-list-head-h: 32px`. Compact (≤900px container) keeps ID, priority, title, status.
- **Peek:** docked width `--issues-peek-w` (default 520px, drag 380px–70% of the Issues body, persisted per workspace). A header control opens a centered sheet over a dim scrim; compact Issues hides the handle and control.

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

- **Do** use OKLCH tokens from `:root` in `index.html`; keep legacy aliases (`--cyan` → `--accent`) when touching older rules.
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
