---
name: design-system-component-library
overview: Turn Minnow's token-only design system into a shared component library and make every released surface consistent with it. Phase 0 completes the token layer (type, spacing, radius, control-size, icon, focus and layer scales) without visible change. Phase 1 builds framework-free DOM primitives under src/ui/components/ with one stylesheet each, unit tests and a gallery fixture. Phase 2 adds a ratcheting CI check so drift can only shrink. Phase 3 moves the existing shared modules and then each released surface onto the primitives, one surface per task. Phase 4 deletes the legacy aliases and duplicate button families and locks the check at zero.
todos:
  - id: W1-A
    content: "Wave 1: Add the scale tokens to tokens.css and pin undefined radius fallbacks"
    status: completed
  - id: W1-B
    content: "Wave 1: Correct DESIGN.md and the design-system token docs"
    status: completed
  - id: W1-C
    content: "Wave 1: Fix fg-on-accent contrast in five palettes"
    status: completed
  - id: W2-A
    content: "Wave 2: Component internals (ids, focus, floating placement)"
    status: completed
  - id: W2-B
    content: "Wave 2: Tooltip"
    status: completed
  - id: W2-C
    content: "Wave 2: Button and IconButton"
    status: completed
  - id: W2-D
    content: "Wave 2: Switch"
    status: completed
  - id: W2-E
    content: "Wave 2: Field controls (input, textarea, select, checkbox, field)"
    status: completed
  - id: W2-F
    content: "Wave 2: Segmented control"
    status: completed
  - id: W2-G
    content: "Wave 2: Tabs"
    status: completed
  - id: W2-H
    content: "Wave 2: Badge and Chip"
    status: completed
  - id: W2-I
    content: "Wave 2: Popover"
    status: completed
  - id: W2-J
    content: "Wave 2: Dialog"
    status: completed
  - id: W2-K
    content: "Wave 2: Barrel, gallery fixture and component docs"
    status: completed
  - id: W3-A
    content: "Wave 3: Design-consistency check with ratcheting baseline"
    status: pending
  - id: W3-B
    content: "Wave 3: Wire the check into CI and agent guidance"
    status: pending
  - id: W4-A
    content: "Wave 4: Rebuild app-dialog on Dialog and Button"
    status: pending
  - id: W4-B
    content: "Wave 4: Settings controls and settings switch delegate to primitives"
    status: pending
  - id: W4-C
    content: "Wave 4: Context menu on shared placement and layer tokens"
    status: pending
  - id: W4-D
    content: "Wave 4: Toast and notification-card actions use Button"
    status: pending
  - id: W5-A
    content: "Wave 5: Code - composer and input bar"
    status: pending
  - id: W5-B
    content: "Wave 5: Code - transcript, tool calls and thinking"
    status: pending
  - id: W5-C
    content: "Wave 5: Code - file panel, editor tabs, terminal and preview chrome"
    status: pending
  - id: W5-D
    content: "Wave 5: Settings surface"
    status: pending
  - id: W5-E
    content: "Wave 5: Source Control and git panels"
    status: pending
  - id: W5-F
    content: "Wave 5: Models"
    status: pending
  - id: W5-G
    content: "Wave 5: Issues"
    status: pending
  - id: W5-H
    content: "Wave 5: Brain and Scheduler"
    status: pending
  - id: W5-I
    content: "Wave 5: Dashboard, shell chrome and sidebar"
    status: pending
  - id: W5-J
    content: "Wave 5: Boards, onboarding and workspace screens"
    status: pending
  - id: W5-K
    content: "Wave 5: Hidden apps (Compare, Bench, Experts, Research)"
    status: pending
  - id: W6-A
    content: "Wave 6: Remove legacy aliases and duplicate button families"
    status: pending
  - id: W6-B
    content: "Wave 6: Lock the check at zero and finalize docs"
    status: pending
isProject: true
---

# Design System Component Library

**Date:** 2026-10-31
**Goal:** Every released Minnow surface builds its controls from one tested component library on one complete token scale, and CI stops new drift.
**Granularity:** medium

## Context

Minnow's design system today is a colour palette and a set of written rules. `src/styles/tokens.css` defines 16 palette themes (8 families in dark and light) on `--mn-*` colour tokens, plus three radii (`--radius-sm/md/lg`) and the `--mn-menu-*` dropdown tokens. `DESIGN.md` and `documentation/design-system/` describe the rules. There is no shared component layer: `documentation/design-system/primitives.md` says outright that primitives are "CSS classes + DOM factories (not a shared component package)".

Measured on main at the time of writing (546 modules in `src/ui/`, 160 stylesheets in `src/styles/`):

- **82 separate button class families** (`.icon-btn`, `.home-button`, `.scc-btn`, `.issues-btn`, `.models-btn`, `.board-btn`, `.sp-btn`, `.m-btn`, `.settings-action-btn`, `.settings-inline-btn`, `.app-dialog-panel__btn`, …). They share one look (1px `--mn-border`, `--radius-sm`, `--mn-bg` fill, 13px/500) at heights between 26px and 40px, each restyled from scratch.
- **No type scale.** About 70 distinct `font-size` values: 12px ×660, 13px ×546, 11px ×498, 10px ×175, 14px ×166, plus half-pixel steps (12.5px ×65, 11.5px ×38, 13.5px ×31, 10.5px ×24) and around 40 different rem values. Source Control has its own private `--scc-text-*` scale.
- **No spacing scale.** Padding, margin and gap use 2/4/6/8/10/12/14/16/20/24/28/32/40/48px (with stray 1/3/5/7/9/11/13px).
- **Thin radius scale.** Besides the three tokens, 4px ×50, 6px ×39, 8px ×24, 3px ×30 and 2px ×22 are hand-written. About 60 declarations reference `--mn-radius-sm/md/lg/xs`, which are **not defined**, so they render whatever their fallback says (`var(--mn-radius-sm, 4px)`, `var(--mn-radius-sm, 8px)`, `var(--mn-radius-md, 8px)`, …). `src/styles/messages.css:333` has no fallback and currently renders square.
- **`--mn-text-*` is already taken by colour aliases** (`--mn-text-muted`, `--mn-text-hover`, `--mn-text-primary`), so a type scale cannot use that prefix.
- **Ad-hoc layering.** z-index runs from 1 to 200000 with no names; `.mn-menu` sits at 96 while `.app-dialog-overlay` sits at 100030, so a context menu opened from a dialog paints underneath it.
- **Duplicate overlays.** 47 modules set `role="dialog"`/`aria-modal`, 19 build their own `role="menu"`, and 492 places set native `title=` tooltips.
- **Shared pieces exist and are widely used:** `app-dialog.ts` (79 importers), `toast.ts` (82), `settings-switch.ts` (37), `context-menu.ts` (19), `settings-controls.ts`, `icon.ts`, `dropdowns.css`. These become the foundation, not competitors.
- **`DESIGN.md` front matter is stale:** its `colors:` block lists `bg`/`surface` as pure white and `accent` as black, which matches no shipped theme, while the body says the default is swamp-dark. `documentation/design-system/tokens.md` still lists `--chat-msg-max: 900px` (code: 1024px).

Constraints that shape the design:

- **No framework.** React is in `package.json` but nothing in `src/` imports it; the UI is plain TypeScript building DOM. `documentation/design-system/dropdowns.md` already states that consistency "does not require a new UI framework". Components are factory functions returning real elements, like `createSettingsSwitch()` and `openContextMenu()`.
- **Bundle budgets** (`budgets.json`, MIN-400). Each component imports its own stylesheet (the `context-menu.ts` precedent), so a primitive costs nothing until a surface imports it, and surface migrations should shrink CSS by deleting the per-surface copies.
- **Apps run inside MinnowOS windows**, so `@media` width queries never match app width. Components size from tokens and container context; only `(hover: hover) and (pointer: fine)`, `(pointer: coarse)` and `prefers-reduced-motion` media queries are allowed in component CSS.
- **Overlay contracts:** anything that paints over the preview calls `markPreviewOccluder(root, kind)` from `src/ui/preview-occlusion.ts`, and overlay roots carry `data-above-shell-overlay` so `src/ui/shell-overlay-state.ts` does not treat clicks inside them as outside clicks.
- **Running UI animation costs local tokens/s** (a single running CSS animation pins the compositor). Component motion is transitions on state change only; busy spinners animate only while busy and stop under reduced motion.
- **Release gating.** Hidden apps (Compare, Bench, Experts, Research) keep working but get migrated last and nothing user-facing may assume they are visible.

## Architecture / Key Files

| File | Role | Action |
|------|------|--------|
| `src/styles/tokens.css` | Palette themes plus all non-colour scale tokens on `:root` | MODIFY |
| `src/styles/{app-picker,code-change-strip,design-mode,dev-server-screen,editor-quick-edit,onboarding,preview-panel,research-panel,tool-call-diff,workspace-welcome-page}.css` | Sites that reference undefined `--mn-radius-*` with fallbacks | MODIFY (pin to current rendered value) |
| `DESIGN.md` | Human spec plus Impeccable front matter | MODIFY |
| `documentation/design-system/tokens.md`, `primitives.md`, `README.md` | Token and primitive inventory | MODIFY |
| `documentation/design-system/components.md` | Component library reference (API, states, a11y, do/don't) | CREATE |
| `src/ui/components/internal.ts` | Id generator, focusable query, Tab-trap, `data-above-shell-overlay` helper | CREATE |
| `src/ui/components/position.ts` | Pure `computeFloatingPosition()` plus DOM `placeFloating()` | CREATE |
| `src/ui/components/button.ts` + `src/styles/components/button.css` | `createButton`, `createIconButton`, `setButtonBusy`, `setButtonPressed` | CREATE |
| `src/ui/components/tooltip.ts` + `src/styles/components/tooltip.css` | `attachTooltip`, `setTooltip`, `hideTooltip` | CREATE |
| `src/ui/components/switch.ts` + `src/styles/components/switch.css` | `createSwitch` | CREATE |
| `src/ui/components/field.ts` + `src/styles/components/field.css` | `createTextInput`, `createTextarea`, `createSelect`, `createCheckbox`, `createField` | CREATE |
| `src/ui/components/segmented.ts` + `src/styles/components/segmented.css` | `createSegmentedControl` | CREATE |
| `src/ui/components/tabs.ts` + `src/styles/components/tabs.css` | `createTabs` | CREATE |
| `src/ui/components/badge.ts` + `src/styles/components/badge.css` | `createBadge`, `createChip` | CREATE |
| `src/ui/components/popover.ts` + `src/styles/components/popover.css` | `openPopover`, `togglePopover`, `closeAllPopovers` | CREATE |
| `src/ui/components/dialog.ts` + `src/styles/components/dialog.css` | `openDialog` | CREATE |
| `src/ui/components/index.ts` | Barrel; also re-exports `openContextMenu`, `notify`/`showToast`, `createIcon` | CREATE |
| `test/fixtures/components-gallery.html` | Every component × variant × state × 16 themes, served by Vite dev | CREATE |
| `test/ui/components/*.test.mts` | One happy-dom suite per component | CREATE |
| `scripts/check-design-consistency.mjs` + `scripts/design-consistency-baseline.json` | Ratcheting drift counter | CREATE |
| `.github/workflows/ci.yml`, `package.json`, `AGENTS.md` | Gate wiring and agent guidance | MODIFY |
| `src/ui/app-dialog.ts`, `src/ui/settings-switch.ts`, `src/ui/settings-controls.ts`, `src/ui/context-menu.ts`, `src/ui/toast.ts` | Existing shared modules moved onto primitives (public APIs unchanged) | MODIFY |
| Surface stylesheets and modules (per Wave 5 task) | Per-surface migration | MODIFY |

### Token scale (Phase 0)

All on `:root` in `tokens.css`, theme-independent:

- **Type:** `--mn-type-2xs` 10px, `--mn-type-xs` 11px, `--mn-type-sm` 12px, `--mn-type-md` 13px, `--mn-type-base` 14px, `--mn-type-lg` 15px, `--mn-type-xl` 16px, `--mn-type-2xl` 18px, `--mn-type-3xl` 20px, `--mn-type-4xl` 24px, `--mn-type-display` 28px.
- **Leading:** `--mn-leading-none` 1, `--mn-leading-tight` 1.2, `--mn-leading-snug` 1.35, `--mn-leading-normal` 1.5, `--mn-leading-relaxed` 1.6.
- **Weight:** `--mn-weight-regular` 400, `--mn-weight-medium` 500, `--mn-weight-semibold` 600.
- **Tracking:** `--mn-tracking-title` -0.02em, `--mn-tracking-label` 0.06em.
- **Spacing (4px grid with half steps):** `--mn-space-0-5` 2px, `-1` 4px, `-1-5` 6px, `-2` 8px, `-2-5` 10px, `-3` 12px, `-3-5` 14px, `-4` 16px, `-5` 20px, `-6` 24px, `-7` 28px, `-8` 32px, `-10` 40px, `-12` 48px.
- **Radius:** canonical `--mn-radius-xs` 4px, `-sm` 6px, `-md` 10px, `-lg` 14px, `-xl` 20px, `-pill` 999px. Legacy `--radius-sm/md/lg` become aliases of the canonical names.
- **Controls:** `--mn-control-h-sm` 28px, `-md` 32px, `-lg` 40px; padding `--mn-control-px-sm/md/lg` (8/12/16px); `--mn-control-gap` 6px.
- **Icons:** `--mn-icon-sm` 14px, `-md` 16px, `-lg` 18px (existing `--mn-icon-size` stays the per-element override).
- **Focus:** `--mn-focus-ring-width` 2px, `--mn-focus-ring-offset` 2px.
- **Layers:** `--mn-z-raised` 1, `--mn-z-sticky` 20, `--mn-z-shell` 50, `--mn-z-capture` 95, `--mn-z-menu` 96, `--mn-z-toast` 100025, `--mn-z-dialog` 100030, `--mn-z-popover` 100040, `--mn-z-tooltip` 100050. The values name today's de facto layers so adoption is behaviour-neutral; popovers and tooltips sit above dialogs so they work inside one.

## Wave Breakdown

### Wave 1 — Token foundation (Phase 0)
Phase 0 must not change what any screen looks like, with one deliberate exception: `src/styles/messages.css:333` (`var(--mn-radius-sm)` with no fallback) goes from square to 6px, which is what its author intended.

#### Task W1-A: Add the scale tokens to tokens.css and pin undefined radius fallbacks
- **Build:** In `src/styles/tokens.css`, inside the existing non-theme `:root` block, add every token listed under "Token scale" above, grouped with a one-line comment per group in the file's existing comment style. Redefine `--radius-sm`, `--radius-md`, `--radius-lg` as `var(--mn-radius-sm)` etc. so the 524 legacy uses keep working. Then pin every site that referenced the previously undefined names to its current rendered value: `var(--mn-radius-sm, 4px)` → `var(--mn-radius-xs)` (design-mode.css, preview-panel.css); `var(--mn-radius-sm, 8px)` and `var(--mn-radius-md, 8px)` → `8px` (code-change-strip.css, editor-quick-edit.css, workspace-welcome-page.css, design-mode.css, research-panel.css; these literals are later removed by the consistency ratchet); `var(--mn-radius-lg, 10px)` → `var(--mn-radius-md)` (workspace-welcome-page.css); and drop now-redundant fallbacks that equal the token (`var(--mn-radius-sm, 6px)` → `var(--mn-radius-sm)`, same for md 10px, lg 14px, xs 4px). Do not touch files with uncommitted changes from other work.
- **Test:** `node --test test/theme-contrast.test.mts` and `npx tsx --test test/appearance/boot-theme.test.mjs` still pass. `grep -rnoE "var\(--mn-radius-[a-z]+, *[0-9]+px\)" src` returns nothing. `npx tsc --noEmit` passes.
- **Accept:** In a running build, `getComputedStyle(document.documentElement).getPropertyValue('--mn-type-md')` is `13px` and `--radius-sm` resolves to `6px`, and the swamp-dark Code surface is pixel-identical to before apart from the one messages.css corner.
- **Touches:** `src/styles/tokens.css`, `src/styles/app-picker.css`, `src/styles/code-change-strip.css`, `src/styles/design-mode.css`, `src/styles/dev-server-screen.css`, `src/styles/editor-quick-edit.css`, `src/styles/onboarding.css`, `src/styles/preview-panel.css`, `src/styles/research-panel.css`, `src/styles/tool-call-diff.css`, `src/styles/workspace-welcome-page.css`

#### Task W1-B: Correct DESIGN.md and the design-system token docs
- **Build:** Rewrite the `DESIGN.md` front matter `colors:` block to the real swamp-dark values from `tokens.css` and change the body sentence that claims it documents swamp-light. Extend `rounded:` with `xs`, `xl`, `pill`; add `spacing:` steps and a `typography:` entry per type step. Add body sections "Type scale", "Spacing", "Control sizes" and "Layers" with the mapping rules from the Notes below, and a "Component library" section pointing to `src/ui/components/` and `documentation/design-system/components.md`. In `documentation/design-system/tokens.md` add the new scale tables, fix `--chat-msg-max` to 1024px, and note that `--mn-text-*` names are colour aliases. Update `documentation/design-system/README.md` so the architecture diagram includes the component layer.
- **Test:** `npm run test:product-wiki` passes; `grep -n "swamp-light" DESIGN.md` no longer claims the front matter is swamp-light; every token named in the new DESIGN.md sections exists in `src/styles/tokens.css` (check with grep).
- **Accept:** A reader of DESIGN.md can find the value and the token name for every type size, spacing step, radius, control height and layer the app uses.
- **Touches:** `DESIGN.md`, `documentation/design-system/tokens.md`, `documentation/design-system/README.md`
- **Depends on:** W1-A

#### Task W1-C: Fix fg-on-accent contrast in five palettes
- **Build:** Measured on the gallery, `--mn-fg-on-accent` on `--mn-accent` (every primary button in the app, old and new) is below WCAG AA 4.5:1 in desert-light (4.17), coral-light (3.93), human-dark (3.01), human-light (3.49) and mint-light (2.75). Done: light text could not reach 4.5:1 on four of these accents even as pure white, so `--mn-fg-on-accent` became a near-black tinted to each family (desert-light `#0d0803` 4.62, coral-light `#130706` 4.60, human-dark `#1e1005` 5.54, human-light `#120a03` 5.01, mint-light `#062215` 5.51), matching the dark on-accent text desert-light and swamp-dark already used; accents are unchanged. Four rules reuse `--mn-fg-on-accent` on a `--mn-danger` fill (`mobile-app.css` badge and `.m-btn--danger`, `.scheduler-job__delete:hover`, skills-library danger hover); those improve in four themes but stay below 4.5:1 and are fixed by moving to the danger Button in Wave 5. Original approach: in those five theme blocks of `src/styles/tokens.css`, adjust `--mn-fg-on-accent` first (darker on light themes, lighter or darker on human-dark as the accent requires) and only touch `--mn-accent` if no on-accent colour reaches 4.5:1, so the family's accent identity is kept. Add the pair to `test/theme-contrast.test.mts` for all 16 themes. Every other text/background pair the components own already passes in all 16 themes.
- **Test:** `npm run test:components` (includes `test/theme-contrast.test.mts`) with the new `fg-on-accent` on `accent` assertion at 4.5:1 for every theme.
- **Accept:** The primary button in the gallery reads at least 4.5:1 in all 16 themes.
- **Touches:** `src/styles/tokens.css`, `test/theme-contrast.test.mts`
- **Depends on:** W1-A

### Wave 2 — Component library (Phase 1)
Every component lives in `src/ui/components/<name>.ts`, imports its own stylesheet from `src/styles/components/<name>.css`, uses only `--mn-*` tokens (no literals other than `0`, `50%`, `1px` hairlines and `999px` via `--mn-radius-pill`), uses the `mn-` class prefix with BEM elements/modifiers, and has a suite at `test/ui/components/<name>.test.mts`. Phase 1 is additive: no existing surface imports a component yet.

#### Task W2-A: Component internals (ids, focus, floating placement)
- **Build:** `src/ui/components/internal.ts` exports `nextComponentId(prefix: string): string`, `FOCUSABLE_SELECTOR`, `focusableWithin(root: HTMLElement): HTMLElement[]` (skips hidden, disabled and `aria-hidden` nodes), `trapTabKey(root: HTMLElement, event: KeyboardEvent): void`, and `markOverlayRoot(root: HTMLElement, kind: PreviewOccluderKind): void` / `unmarkOverlayRoot(root)` which set `data-above-shell-overlay` and call `markPreviewOccluder`/`unmarkPreviewOccluder`. `src/ui/components/position.ts` exports `type FloatingPlacement = 'top' | 'top-start' | 'top-end' | 'bottom' | 'bottom-start' | 'bottom-end' | 'left' | 'right'`, a pure `computeFloatingPosition(anchor: RectLike, size: {width, height}, viewport: {width, height}, options: {placement, offset, edgeGap}): {left, top, placement}` that flips to the opposite side when the preferred side clips and clamps into the viewport, and `placeFloating(el, anchor, options)` that measures with `getBoundingClientRect` and writes `left`/`top` plus `data-placement`.
- **Test:** `test/ui/components/position.test.mts` asserts with fixed rectangles: bottom-start below the anchor at `offset`; flip to top when the bottom would clip; clamp at `edgeGap` on both horizontal edges; left/right flip. `test/ui/components/internal.test.mts` asserts `trapTabKey` wraps Tab and Shift+Tab and that `focusableWithin` skips disabled/hidden nodes. Run `npm run test:components`.
- **Accept:** `computeFloatingPosition` returns a flipped placement for an anchor 10px above the viewport bottom.
- **Touches:** `src/ui/components/internal.ts`, `src/ui/components/position.ts`, `test/ui/components/position.test.mts`, `test/ui/components/internal.test.mts`
- **Depends on:** W1-A

#### Task W2-B: Tooltip
- **Build:** `src/ui/components/tooltip.ts` exports `attachTooltip(target: HTMLElement, text: string, options?: {placement?: FloatingPlacement}): () => void`, `setTooltip(target, text)`, `hideTooltip()`. One shared `.mn-tooltip` element (`role="tooltip"`, stable id) is created lazily on `document.body`. It shows after `TOOLTIP_DELAY_MS` (400) on fine-pointer `pointerenter`, immediately on keyboard focus (`:focus-visible` match), and hides on `pointerleave`, `blur`, `pointerdown`, Escape and scroll. While shown it sets `aria-describedby` on the target unless the text equals the target's `aria-label` (no double announcement). It removes any `title` attribute on attach so the native tooltip does not double up. Placement uses `placeFloating`; the root uses `markOverlayRoot(root, 'panel')` and `z-index: var(--mn-z-tooltip)`. CSS: `--mn-type-sm`, `--mn-surface-2` fill, `--mn-border-strong` hairline, `--mn-radius-sm`, max width 280px, opacity transition only, no motion under reduced motion.
- **Test:** `test/ui/components/tooltip.test.mts`: focus shows synchronously with the text and sets `aria-describedby`; pointerenter shows only after the delay (inject timers via `mock.timers`); Escape hides; detach removes listeners and the describedby link; text equal to `aria-label` produces no describedby.
- **Accept:** Hovering an icon button in the gallery shows a themed tooltip and the native `title` tooltip no longer appears.
- **Touches:** `src/ui/components/tooltip.ts`, `src/styles/components/tooltip.css`, `test/ui/components/tooltip.test.mts`
- **Depends on:** W2-A

#### Task W2-C: Button and IconButton
- **Build:** `src/ui/components/button.ts` exports `type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'`, `type ButtonSize = 'sm' | 'md' | 'lg'`, `interface ButtonOptions {label?, icon?: IconName, iconEnd?: IconName, variant?, size?, type?, disabled?, pressed?, block?, ariaLabel?, tooltip?, className?, onClick?}`, `createButton(options): HTMLButtonElement`, `createIconButton(options: {icon, label, variant?, size?, …}): HTMLButtonElement` (label becomes `aria-label` and the tooltip), `setButtonBusy(button, busy: boolean)` (sets `aria-busy`, disables, shows a CSS spinner only while busy) and `setButtonPressed(button, pressed)`. Defaults: `secondary`, `md`, `type="button"`. Classes `.mn-btn`, `.mn-btn--{variant}`, `.mn-btn--{size}`, `.mn-btn--icon`, `.mn-btn--block`, `.mn-btn__icon`, `.mn-btn__label`. Visual baseline is the shared look of today's families, with two deliberate corrections found in the gallery: secondary = `--mn-bg` fill, 1px `--mn-border-strong` (the plain `--mn-border` made secondary indistinguishable from ghost on dark themes), `--mn-radius-sm`, `--mn-type-md`/medium; primary = accent fill with `--mn-fg-on-accent`; ghost = transparent until hover (`--mn-surface-elevated`); danger = text mixed 65% `--mn-danger` / 35% `--mn-fg` (raw `--mn-danger` is about 4:1 on light themes) with danger-soft hover. Heights from `--mn-control-h-*`, icon buttons are square, coarse pointers get `min-height: var(--touch-min)`. Hover only inside `(hover: hover) and (pointer: fine)`; `[aria-pressed="true"]` uses accent-soft fill and accent border.
- **Test:** `test/ui/components/button.test.mts`: defaults produce `type="button"` with secondary/md classes; each variant and size maps to its class; `pressed` sets `aria-pressed`; icon button has `aria-label` and a tooltip attached; `setButtonBusy(true)` disables and sets `aria-busy="true"`, `false` restores the prior disabled state; click handler fires and does not fire while disabled.
- **Accept:** The gallery shows all 4 variants × 3 sizes with label, icon+label and icon-only forms, and every one is reachable by Tab with the shared focus ring.
- **Touches:** `src/ui/components/button.ts`, `src/styles/components/button.css`, `test/ui/components/button.test.mts`
- **Depends on:** W2-B

#### Task W2-D: Switch
- **Build:** `src/ui/components/switch.ts` exports `interface SwitchOptions {id?, name?, checked?, disabled?, ariaLabel?, labelledBy?, describedBy?, size?: 'sm' | 'md', onChange?}` and `createSwitch(options): {root: HTMLLabelElement, input: HTMLInputElement}`. Markup mirrors `createSettingsSwitch()` (visually hidden checkbox with `role="switch"`, track and thumb spans) under `.mn-switch`, `.mn-switch__input`, `.mn-switch__track`, `.mn-switch__thumb`, so W4-B can delegate without changing behaviour. Geometry: md track 40×22 (today's settings switch), sm 32×18; a 40px square hit area on md; thumb travel via `transform` only.
- **Test:** `test/ui/components/switch.test.mts`: `role="switch"` on a checkbox input; `checked`/`disabled` reflected; `onChange` receives the new boolean on a `change` event; `labelledBy` and `describedBy` set the ARIA attributes; size class applied.
- **Accept:** Toggling a gallery switch with Space flips it and fires `onChange` once.
- **Touches:** `src/ui/components/switch.ts`, `src/styles/components/switch.css`, `test/ui/components/switch.test.mts`
- **Depends on:** W1-A

#### Task W2-E: Field controls (input, textarea, select, checkbox, field)
- **Build:** `src/ui/components/field.ts` exports `createTextInput(options)` → `HTMLInputElement.mn-input`, `createTextarea(options)` → `HTMLTextAreaElement.mn-input.mn-input--multiline`, `createSelect(options: {options: {value, label, disabled?}[], value?, …})` → `HTMLSelectElement.mn-select` (keeps the native select so `dropdowns.css` and `installThemedSelects()` still style its popup), `createCheckbox(options: {label, checked?, …})` → `{root: HTMLLabelElement.mn-checkbox, input}`, and `createField(options: {label, control: HTMLElement, hint?, error?, required?})` → `{root, label, hint, error, setError(message: string | null)}` which links `for`/`id`, `aria-describedby` (hint and error) and `aria-invalid`. Shared options: `id`, `name`, `value`, `placeholder`, `size: 'sm' | 'md' | 'lg'`, `disabled`, `invalid`, `ariaLabel`, `onInput`, `onChange`. Inputs use `--mn-bg` fill, `--mn-border-strong` (visible edge, matching secondary buttons), `--mn-radius-sm`, height `--mn-control-h-*`, focus border `--mn-accent`; invalid uses `--mn-danger-border`; coarse pointer inputs use `--mn-type-xl` (16px, iOS anti-zoom); `caret-color` follows `global.css`.
- **Test:** `test/ui/components/field.test.mts`: field wires `label[for]` to the control id; hint and error ids appear in `aria-describedby`; `setError('x')` shows the error and sets `aria-invalid="true"`, `setError(null)` removes both; select renders options with the selected value; checkbox `onChange` fires with the boolean.
- **Accept:** A gallery field with an error announces label, hint and error to a screen reader (verified through the accessibility tree).
- **Touches:** `src/ui/components/field.ts`, `src/styles/components/field.css`, `test/ui/components/field.test.mts`
- **Depends on:** W1-A

#### Task W2-F: Segmented control
- **Build:** `src/ui/components/segmented.ts` exports `interface SegmentedOption {value: string, label: string, icon?: IconName, disabled?: boolean}` and `createSegmentedControl(options: {options, value, ariaLabel, size?, onChange?})` → `{root, getValue(), setValue(value, opts?: {silent?: boolean}), setDisabled(value, disabled)}`. `role="radiogroup"` with `role="radio"` buttons, `aria-checked`, roving `tabindex`; Arrow keys move and select (skipping disabled), Home/End jump. Classes `.mn-segmented`, `.mn-segmented__option`, `.is-selected`. Look follows today's `.settings-segment` and `.home-segments`: `--mn-bg` track with a 2px inset, selected option on `--mn-surface-2`.
- **Test:** `test/ui/components/segmented.test.mts`: exactly one option has `tabindex="0"` and `aria-checked="true"`; ArrowRight selects the next enabled option and fires `onChange`; `setValue(v, {silent: true})` does not fire `onChange`; Home/End work.
- **Accept:** Arrow keys move the selection in the gallery without moving focus out of the control.
- **Touches:** `src/ui/components/segmented.ts`, `src/styles/components/segmented.css`, `test/ui/components/segmented.test.mts`
- **Depends on:** W1-A

#### Task W2-G: Tabs
- **Build:** `src/ui/components/tabs.ts` exports `interface TabSpec {id: string, label: string, icon?: IconName, count?: number, disabled?: boolean, panel?: HTMLElement}` and `createTabs(options: {tabs, selected?, ariaLabel, activation?: 'auto' | 'manual', variant?: 'underline' | 'contained', onChange?})` → `{root, list, select(id, opts?), getSelected(), setCount(id, count)}`. WAI-ARIA tabs: `role="tablist"`/`tab`/`tabpanel`, `aria-selected`, `aria-controls`/`aria-labelledby` when panels are given, roving `tabindex`, Arrow/Home/End, manual activation on Enter/Space. Non-selected panels are `hidden`. Tabs without panels are allowed (the caller swaps content in `onChange`). Classes `.mn-tabs`, `.mn-tabs__list`, `.mn-tabs__tab`, `.mn-tabs__count`, `.mn-tabs__panel`.
- **Test:** `test/ui/components/tabs.test.mts`: ARIA wiring between tab and panel; auto activation selects on ArrowRight; manual activation only moves focus until Enter; disabled tabs are skipped; non-selected panels are hidden; `setCount` updates the count badge text.
- **Accept:** The gallery tab set switches panels by keyboard with correct `aria-selected` on each tab.
- **Touches:** `src/ui/components/tabs.ts`, `src/styles/components/tabs.css`, `test/ui/components/tabs.test.mts`
- **Depends on:** W1-A

#### Task W2-H: Badge and Chip
- **Build:** `src/ui/components/badge.ts` exports `type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'`, `createBadge(options: {label, tone?, size?: 'sm' | 'md', dot?, icon?, mono?})` → `HTMLSpanElement.mn-badge`, and `createChip(options: {label, tone?, icon?, selected?, onClick?, onRemove?, removeLabel?})` → `HTMLElement.mn-chip` (a `<button>` with `aria-pressed` when clickable, otherwise a span; `onRemove` appends an icon button labelled `removeLabel ?? 'Remove ' + label`). Tones use the existing `*-soft` / `*-border` / `*-ink` tokens; warning has no ink token, so its text is 45% `--mn-warning` mixed into `--mn-fg` (raw warning text drops to 1.9:1 on human-light). Badges are status and measurement only (the Metric Color Rule); `neutral` and `accent` cover everything else.
- **Test:** `test/ui/components/badge.test.mts`: tone and size classes; `dot` renders a dot element; clickable chip is a button with `aria-pressed`; remove button has an accessible name and calls `onRemove` without triggering `onClick`.
- **Accept:** The gallery shows every tone in all 16 themes with readable text.
- **Touches:** `src/ui/components/badge.ts`, `src/styles/components/badge.css`, `test/ui/components/badge.test.mts`
- **Depends on:** W2-C

#### Task W2-I: Popover
- **Build:** `src/ui/components/popover.ts` exports `interface PopoverOptions {anchor: HTMLElement, content: HTMLElement, placement?: FloatingPlacement, offset?: number, ariaLabel?: string, role?: 'dialog' | 'group', className?: string, matchAnchorWidth?: boolean, initialFocus?: HTMLElement | 'first' | 'none', onClose?: (reason: PopoverCloseReason) => void}`, `type PopoverCloseReason = 'escape' | 'outside' | 'anchor' | 'api'`, `openPopover(options): PopoverHandle` (`{root, close(reason?), reposition(), isOpen()}`), `togglePopover(options)` (closes when already open for that anchor) and `closeAllPopovers()`. One `.mn-popover` root per open popover, fixed, `z-index: var(--mn-z-popover)`, styled with the `--mn-menu-*` surface tokens. A stack of open popovers: outside `pointerdown` closes from the top down until it reaches one that contains the target (clicks inside `.mn-menu` and `.mn-tooltip` count as inside); Escape closes only the top one and restores focus to its anchor. Anchor gets `aria-expanded` and `aria-controls`. Repositions on resize and capture-phase scroll; `markOverlayRoot(root, 'menu')`.
- **Test:** `test/ui/components/popover.test.mts`: opening sets `aria-expanded="true"` and `aria-controls`; Escape closes and returns focus to the anchor with reason `escape`; outside pointerdown closes with `outside`; pointerdown inside a nested child popover leaves the parent open; `togglePopover` on the same anchor closes; the root carries `mn-occludes-preview` and `data-above-shell-overlay`.
- **Accept:** A gallery popover opened inside a gallery dialog paints above the dialog and Escape closes only the popover.
- **Touches:** `src/ui/components/popover.ts`, `src/styles/components/popover.css`, `test/ui/components/popover.test.mts`
- **Depends on:** W2-A

#### Task W2-J: Dialog
- **Build:** `src/ui/components/dialog.ts` exports `interface DialogAction {id: string, label: string, variant?: ButtonVariant, autoFocus?: boolean, run?: () => boolean | void | Promise<boolean | void>}`, `interface DialogOptions {title: string, description?: string, body?: HTMLElement | string, actions?: DialogAction[], size?: 'sm' | 'md' | 'lg', dismissible?: boolean, closeButton?: boolean, initialFocus?: HTMLElement, onClose?: (result: string | null) => void}` and `openDialog(options): DialogHandle` (`{overlay, panel, body, footer, close(result?), closed: Promise<string | null>, setBusy(busy)}`). Fixed overlay `.mn-dialog-overlay` (`--mn-overlay` scrim, `z-index: var(--mn-z-dialog)`) holding `.mn-dialog` with `role="dialog"`, `aria-modal="true"`, `aria-labelledby`/`aria-describedby`. Focus trap via `trapTabKey`; initial focus goes to `initialFocus`, then the `autoFocus` action, then the first focusable; focus is restored on close. Escape and scrim click resolve `null` when `dismissible` (default true); only the topmost of several open dialogs reacts. Actions render with `createButton`; a `run` that returns or resolves `false` keeps the dialog open, and `setBusy(true)` disables every action while async work runs. `markOverlayRoot(overlay, 'dialog')`. Widths: sm 360px, md 28rem (today's app-dialog), lg 640px, all capped at the viewport minus 24px.
- **Test:** `test/ui/components/dialog.test.mts`: ARIA wiring; focus lands on the autoFocus action and returns to the opener on close; Escape resolves `closed` with `null`; non-dismissible ignores Escape and scrim; a `run` returning `false` keeps it open; with two dialogs open, Escape closes only the top one; Tab wraps inside the panel.
- **Accept:** A gallery dialog traps focus, closes on Escape and returns focus to the button that opened it.
- **Touches:** `src/ui/components/dialog.ts`, `src/styles/components/dialog.css`, `test/ui/components/dialog.test.mts`
- **Depends on:** W2-A, W2-C

#### Task W2-K: Barrel, gallery fixture and component docs
- **Build:** `src/ui/components/index.ts` re-exports every public symbol from the component modules plus `openContextMenu`, `closeContextMenu` and the `MenuItem` types from `../context-menu`, `notify`, `showToast` and their types from `../toast`, and `createIcon`/`IconName` from `../icon`, so surfaces have one import path. `test/fixtures/components-gallery.html` (pattern: `test/fixtures/question-cards-qa.html`) imports tokens, global and icon CSS plus the barrel, and renders sections for every component, variant, size and state (default, hover via forced class, focus, disabled, busy, invalid, selected), with a toolbar to switch all 16 themes and a narrow-width toggle. Write `documentation/design-system/components.md`: when to use each component, its options, keyboard model, ARIA contract, and do/don't, and how to open the gallery (`npm run dev -- --port 5173 --strictPort`, then `/test/fixtures/components-gallery.html`). Update `documentation/design-system/primitives.md` to point at the library and mark the per-surface classes as legacy. Add a short "Component library" entry to `documentation/context.md`. Register a `components` scoped suite in `test/test-config.mjs` (component suites plus `test/theme-contrast.test.mts`) and a `test:components` script in `package.json`.
- **Test:** `test/ui/components/index.test.mts` imports the barrel and asserts each factory is a function. `npx tsc --noEmit` passes. Load the gallery in the browser pane: no console errors, and every section renders in swamp-dark, coral-light and matrix-dark.
- **Accept:** One page shows the whole library in any theme, and docs describe every component it shows.
- **Touches:** `src/ui/components/index.ts`, `test/fixtures/components-gallery.html`, `test/ui/components/index.test.mts`, `test/ui/components/component-dom.mts`, `test/test-config.mjs`, `package.json`, `documentation/design-system/components.md`, `documentation/design-system/primitives.md`, `documentation/context.md`
- **Depends on:** W2-B, W2-C, W2-D, W2-E, W2-F, W2-G, W2-H, W2-I, W2-J

### Wave 3 — Consistency gate (Phase 2)

#### Task W3-A: Design-consistency check with ratcheting baseline
- **Build:** `scripts/check-design-consistency.mjs` scans `src/styles/**/*.css` (excluding `tokens.css` and `src/styles/vendor/**`) and `src/**/*.ts` and counts per file: `font-size` values that are not a `var(--mn-type-*)` (or `inherit`, `0`, `1em`, `100%`); `border-radius` values other than `var(--mn-radius-*)`, legacy `var(--radius-*)`, `0`, `50%`, `inherit`; `font-weight` outside 400/500/600 or their tokens; numeric `z-index` above 2 that is not `var(--mn-z-*)`; colour literals (hex, `rgb(`, `hsl(`, `oklch(`) outside `tokens.css`; class selectors matching `-btn\b|-button\b` defined outside `src/styles/components/`; and in TS, `createElement('button')` outside `src/ui/components/`. Results compare against `scripts/design-consistency-baseline.json` (per file, per rule). Any increase fails with file, rule, old and new count; decreases print a reminder to run `--update-baseline`. Flags: `--update-baseline`, `--json`, `--file <path>`. Mirror the style of `scripts/check-performance-budgets.mjs`. Add `"check:design-consistency": "node scripts/check-design-consistency.mjs"` to `package.json`.
- **Test:** `test/scripts/check-design-consistency.test.mjs` runs the counter on fixture CSS/TS strings (exported `countDesignDrift(source, kind)`): a hex in a non-token file counts, `var(--mn-type-sm)` does not, `border-radius: 50%` does not, `z-index: var(--mn-z-dialog)` does not; and `compareToBaseline()` reports an increase as a failure and a decrease as a pass.
- **Accept:** Adding `font-size: 12.5px` to any stylesheet makes `npm run check:design-consistency` exit 1 naming that file.
- **Touches:** `scripts/check-design-consistency.mjs`, `scripts/design-consistency-baseline.json`, `test/scripts/check-design-consistency.test.mjs`, `package.json`
- **Depends on:** W2-K

#### Task W3-B: Wire the check into CI and agent guidance
- **Build:** Add a fast Ubuntu job "design consistency" to `.github/workflows/ci.yml` that runs `npm ci` and `npm run check:design-consistency`. In `AGENTS.md` under Conventions add: build controls from `src/ui/components/` (import from the barrel), never add a new `*-btn` family, use `--mn-type-*`/`--mn-space-*`/`--mn-radius-*`/`--mn-z-*`, and how to refresh the baseline after a migration shrinks it. Add the same rule to the Do list in `DESIGN.md`.
- **Test:** `npm run test:check-coverage` passes; the workflow YAML parses (`node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8'))"` or the repo's existing workflow test if present).
- **Accept:** A pull request that adds a hard-coded colour outside `tokens.css` shows a failing "design consistency" check.
- **Touches:** `.github/workflows/ci.yml`, `AGENTS.md`, `DESIGN.md`
- **Depends on:** W3-A

### Wave 4 — Shared modules onto primitives (Phase 3a)
These keep every public API and every existing test unchanged. Legacy class names stay on the rendered elements as aliases until Wave 6 so surface CSS that targets them keeps working.

#### Task W4-A: Rebuild app-dialog on Dialog and Button
- **Build:** Reimplement the internals of `src/ui/app-dialog.ts` (`appAlert`, `appConfirm`, `appPrompt`, `appChoice`, `installAppDialogs`, `isAppDialogOpen`, `resetAppDialogForTests`) on `openDialog()` and `createButton()`, keeping the queueing (`enqueueDialog`), the element ids (`appDialogOverlay`, `appDialogPanel`, `appDialogTitle`), the `data-dialog-action` attributes, danger-confirm initial focus on Cancel, and the Electron-only interception. Prompt input uses `createTextInput`. Delete the now-duplicate rules from `src/styles/app-dialog.css`, leaving only what the alias classes still need.
- **Test:** the single-file run (Notes) of `test/ui/app-dialog.test.mts` passes unchanged; plus the suites of the five largest `appConfirm` callers found with `grep -rl "appConfirm" test`.
- **Accept:** Deleting a chat shows the same confirm dialog, now built from the shared Dialog, with focus on Cancel.
- **Touches:** `src/ui/app-dialog.ts`, `src/styles/app-dialog.css`
- **Depends on:** W2-K

#### Task W4-B: Settings controls and settings switch delegate to primitives
- **Build:** `createSettingsSwitch()` in `src/ui/settings-switch.ts` returns `createSwitch()` output with the legacy `settings-switch*` classes added beside the `mn-switch*` ones; `wrapCheckboxAsSwitch`/`upgradeSettingsCheckboxes` keep working. In `src/ui/settings-controls.ts`, `createSettingsSelectRow`, `createSettingsInputRow`, `createSettingsTextareaRow` and `createSettingsActionsRow` build their controls with `createSelect`, `createTextInput`, `createTextarea` and `createButton` (actions map `primary`/`danger` to variants). Remove the duplicated switch, input and action-button rules from `src/styles/settings-controls.css` once the aliases are covered by component CSS.
- **Test:** the single-file run (Notes) of `test/ui/settings-switch.test.mjs test/ui/settings-controls.test.mjs` pass; `npm run test:settings` passes.
- **Accept:** Every toggle on Settings → General renders as `.mn-switch` and behaves as before.
- **Touches:** `src/ui/settings-switch.ts`, `src/ui/settings-controls.ts`, `src/styles/settings-controls.css`
- **Depends on:** W2-K

#### Task W4-C: Context menu on shared placement and layer tokens
- **Build:** Replace `positionAtPoint`, `positionAtAnchor` and `positionSubmenu` in `src/ui/context-menu.ts` with `computeFloatingPosition`/`placeFloating` from `src/ui/components/position.ts` (submenus use `right` with flip). Set `.mn-menu` in `src/styles/context-menu.css` to `z-index: var(--mn-z-popover)` so menus opened from dialogs paint above them, and keep it above `--mn-z-capture`. `.mn-dropdown` in `src/styles/dropdowns.css` uses the same layer.
- **Test:** the single-file run (Notes) of `test/ui/context-menu.test.mts` passes; add a case asserting a menu anchored near the right edge flips its submenu left.
- **Accept:** Right-clicking inside an open confirm dialog shows the menu above the dialog.
- **Touches:** `src/ui/context-menu.ts`, `src/styles/context-menu.css`, `src/styles/dropdowns.css`, `test/ui/context-menu.test.mts`
- **Depends on:** W2-K

#### Task W4-D: Toast and notification-card actions use Button
- **Build:** After the in-flight notification-card work in `src/ui/toast.ts` and `src/notifications/cards.ts` is committed, render `NotifyAction` buttons with `createButton` (`variant: 'primary'` maps directly, others become `ghost`, size `sm`) and the dismiss control with `createIconButton({icon: 'close', label: 'Dismiss'})`. Move `.mn-toast` stacking to `z-index: var(--mn-z-toast)`. Delete the per-toast button rules from `src/styles/toast.css`.
- **Test:** the single-file run (Notes) of `test/ui/toast.test.mjs test/notifications/cards.test.mts test/ui/memory-saved-toast.test.mjs` pass.
- **Accept:** A "Turn failed" card shows its action as a small shared button in every theme.
- **Touches:** `src/ui/toast.ts`, `src/styles/toast.css`
- **Depends on:** W2-K

### Wave 5 — Surface migrations (Phase 3b)
Each task: replace the surface's own button/input/switch/tab/segment/badge/dialog/popover builders with components, replace literals with scale tokens using the mapping in the Notes, delete the dead per-surface classes, run `npm run check:design-consistency -- --update-baseline` so the baseline records the drop, and compare before/after screenshots in swamp-dark and one light theme. Visual change should be limited to snapping to the scale. Code goes first because it is the primary surface.

#### Task W5-A: Code - composer and input bar
- **Build:** Migrate `src/ui/composer-*.ts`, `src/ui/input.ts` and `src/styles/{input,composer-controls,composer-expand,composer-message-queue,composer-model-trigger,composer-overflow,composer-pinned-skill,composer-tools-popover,mode-selector,skill-picker}.css`. `.send-btn` becomes `createIconButton({variant: 'primary', size: 'lg'})` keeping its 44px coarse target; composer popovers (`composer-tools-popover.ts`, `composer-run-target-menu.ts`) open with `openPopover`; `.composer-*-btn` families collapse to `ghost` icon buttons with tooltips.
- **Test:** `npm run test:engine` and the single-file run (Notes) of `test/ui/composer-*.test.*` pass; design-consistency counts for the touched files drop and the baseline is updated.
- **Accept:** The composer shows no `-btn` class outside the component layer and its controls share heights with the rest of Code.
- **Touches:** `src/ui/composer-*.ts`, `src/ui/input.ts`, `src/styles/input.css`, `src/styles/composer-*.css`, `src/styles/mode-selector.css`, `src/styles/skill-picker.css`, `scripts/design-consistency-baseline.json`
- **Depends on:** W3-B, W4-A, W4-C

#### Task W5-B: Code - transcript, tool calls and thinking
- **Build:** Migrate `src/ui/messages.ts`, `src/ui/tool-messages.ts`, `src/ui/tool-call-batch.ts`, `src/ui/message-actions*.ts` and `src/styles/{messages,message-actions,thoughts,tool-call-diff,code-change-strip,chat-link-chips,compaction-divider,context-notice}.css`. Stat chips (`.stat-chip .c/.g/.y/.r`) become `createBadge({mono: true, size: 'sm'})` with tones; message action buttons become ghost icon buttons with tooltips.
- **Test:** the single-file run (Notes) of `test/ui/messages*.test.* test/ui/tool-*.test.*` pass; baseline updated.
- **Accept:** Per-message stat chips render through `.mn-badge` with the same tones.
- **Touches:** `src/ui/messages.ts`, `src/ui/tool-messages.ts`, `src/ui/tool-call-batch.ts`, `src/ui/message-actions*.ts`, `src/styles/messages.css`, `src/styles/message-actions.css`, `src/styles/thoughts.css`, `src/styles/tool-call-diff.css`, `src/styles/code-change-strip.css`, `src/styles/chat-link-chips.css`, `src/styles/compaction-divider.css`, `src/styles/context-notice.css`, `scripts/design-consistency-baseline.json`
- **Depends on:** W5-A

#### Task W5-C: Code - file panel, editor tabs, terminal and preview chrome
- **Build:** Migrate `src/ui/file-*.ts`, `src/ui/terminal-tabs.ts`, `src/ui/terminal-panel.ts`, `src/ui/preview-*.ts`, `src/ui/unified-right-tabs.ts`, `src/ui/right-pane-slot-tabs.ts` and `src/styles/{file-panel,terminal,preview-panel,code-chrome,editor-quick-edit,editor-intent-mode}.css`. Editor/terminal/preview/right-pane tab strips use `createTabs({variant: 'underline'})` (closable tabs keep their close icon button inside the tab); `file-panel.css` loses its 15 colour literals.
- **Test:** `npm run test:terminal-pty` and the single-file run (Notes) of `test/ui/file-*.test.* test/ui/preview-*.test.*` pass; baseline updated.
- **Accept:** Editor, terminal and preview tab strips share one tab component and keyboard model.
- **Touches:** `src/ui/file-*.ts`, `src/ui/terminal-tabs.ts`, `src/ui/terminal-panel.ts`, `src/ui/preview-*.ts`, `src/ui/unified-right-tabs.ts`, `src/ui/right-pane-slot-tabs.ts`, `src/styles/file-panel.css`, `src/styles/terminal.css`, `src/styles/preview-panel.css`, `src/styles/code-chrome.css`, `src/styles/editor-quick-edit.css`, `src/styles/editor-intent-mode.css`, `scripts/design-consistency-baseline.json`
- **Depends on:** W5-B

#### Task W5-D: Settings surface
- **Build:** Migrate `src/settings/**` page modules and `src/styles/settings*.css` (31 files). `.settings-inline-btn` and `.settings-action-btn` call sites move to `createButton`; `.settings-segment` to `createSegmentedControl`; settings nav tabs to `createTabs`.
- **Test:** `npm run test:settings` passes; baseline updated.
- **Accept:** No Settings stylesheet defines a button class.
- **Touches:** `src/settings/**`, `src/styles/settings*.css`, `scripts/design-consistency-baseline.json`
- **Depends on:** W4-B, W5-C

#### Task W5-E: Source Control and git panels
- **Build:** Migrate `src/ui/git-*.ts`, `src/ui/scc-*.ts`, `src/ui/branch-picker.ts`, `src/ui/pr-review-panel.ts` and `src/styles/{source-control-center,scc-actions,git-*,branch-picker,pr-review,github-account}.css`. Turn `--scc-text-*` into aliases of `--mn-type-*` (keeping `--scc-title-xl`/`--scc-title-compact` as named title steps on the scale) and `--scc-btn-h` into `--mn-control-h-sm`.
- **Test:** the single-file run (Notes) of `test/ui/git-*.test.* test/ui/scc-*.test.* test/ui/pr-review*.test.*` pass; baseline updated.
- **Accept:** Source Control buttons match Code's buttons at the same size.
- **Touches:** `src/ui/git-*.ts`, `src/ui/scc-*.ts`, `src/ui/branch-picker.ts`, `src/ui/pr-review-panel.ts`, `src/styles/source-control-center.css`, `src/styles/scc-actions.css`, `src/styles/git-*.css`, `src/styles/branch-picker.css`, `src/styles/pr-review.css`, `src/styles/github-account.css`, `scripts/design-consistency-baseline.json`
- **Depends on:** W5-D

#### Task W5-F: Models
- **Build:** Migrate `src/models/**` UI modules, `src/ui/model-*.ts`, `src/ui/models-*.ts` and `src/styles/{models-*,model-*,router-route}.css`. `.models-btn`, `.models-icon-btn`, `.models-inline-btn` collapse to Button/IconButton; load-state labels become Badges.
- **Test:** `npm run test:servers` and the single-file run (Notes) of `test/ui/models-*.test.* test/models/*.test.*` pass; baseline updated.
- **Accept:** The Models page has no surface-specific button classes.
- **Touches:** `src/models/**`, `src/ui/model-*.ts`, `src/ui/models-*.ts`, `src/styles/models-*.css`, `src/styles/model-*.css`, `src/styles/router-route.css`, `scripts/design-consistency-baseline.json`
- **Depends on:** W5-E

#### Task W5-G: Issues
- **Build:** Migrate `src/issues/**` UI, `src/ui/issues-*.ts` and `src/styles/issue*.css`. `.issues-btn` → Button; status and priority chips → Badge; label chips keep their `--mn-label-*` swatches through a `createChip` `swatch` data attribute; the details panel uses `openDialog({size: 'lg'})` or keeps its own frame if layout requires, but its controls use components.
- **Test:** `npm run test:issues` passes; baseline updated.
- **Accept:** Issue rows, details and capture use shared controls and keep the 36px row density.
- **Touches:** `src/issues/**`, `src/ui/issues-*.ts`, `src/styles/issue*.css`, `scripts/design-consistency-baseline.json`
- **Depends on:** W5-F

#### Task W5-H: Brain and Scheduler
- **Build:** Migrate `src/brain/**` UI, `src/ui/brain*.ts`, `src/scheduler/**` UI and `src/styles/{brain-*,scheduler-*}.css`. `.brain-action-btn` → Button.
- **Test:** `npm run test:brain` and `npm run test:scheduler` pass; baseline updated.
- **Accept:** Brain and Scheduler controls match Code at the same sizes.
- **Touches:** `src/brain/**`, `src/ui/brain*.ts`, `src/scheduler/**`, `src/styles/brain-*.css`, `src/styles/scheduler-*.css`, `scripts/design-consistency-baseline.json`
- **Depends on:** W5-G

#### Task W5-I: Dashboard, shell chrome and sidebar
- **Build:** Migrate `src/home/**`, `src/os/**` chrome, `src/ui/sidebar*.ts`, `src/ui/workspace-*.ts` and `src/styles/{home,minnowos-*,topbar,sidebar,workspace-menu,app-picker,update-menubar,shell-keyboard-help,command-palette}.css`. `.home-button` (37 rules) and `.icon-btn` (70 rules) collapse to Button/IconButton; `.home-segments` → SegmentedControl; `--os-r-md: 9px` → `--mn-radius-md`; shell z-indexes move to `--mn-z-*`. Window chrome buttons keep `--os-window-btn-size`.
- **Test:** `npm run test:onboarding` and the single-file run (Notes) of `test/os/**/*.test.* test/home/**/*.test.* test/ui/sidebar*.test.*` pass; `test/boot/boot-budget-ci.test.mts` passes; baseline updated.
- **Accept:** The dock, menubar, sidebar and Dashboard use one button component.
- **Touches:** `src/home/**`, `src/os/**`, `src/ui/sidebar*.ts`, `src/ui/workspace-*.ts`, `src/styles/home.css`, `src/styles/minnowos-*.css`, `src/styles/topbar.css`, `src/styles/sidebar.css`, `src/styles/workspace-menu.css`, `src/styles/app-picker.css`, `src/styles/update-menubar.css`, `src/styles/shell-keyboard-help.css`, `src/styles/command-palette.css`, `scripts/design-consistency-baseline.json`
- **Depends on:** W5-H

#### Task W5-J: Boards, onboarding and workspace screens
- **Build:** Migrate `src/orchestrator/**` UI, `src/onboarding/**`, `src/ui/orchestrate-*.ts`, `src/ui/sub-agent-*.ts` and `src/styles/{orchestrate-*,orchestrator-boards,sub-agent-drawer,plan-progress,onboarding,ob-page,workspace-gate,workspace-welcome-page,workspace-folder-picker,dev-server-screen,device-request-prompt,question-cards,tool-approval,agent-*}.css`. `.board-btn`, `.ov2-btn`, `.sp-btn` → Button; question cards and tool approval use components for their actions; `orchestrate-board.css` and `onboarding.css` lose their colour literals.
- **Test:** `npm run test:orchestrator` and `npm run test:onboarding` pass; baseline updated.
- **Accept:** Boards and onboarding have no surface-specific button classes.
- **Touches:** `src/orchestrator/**`, `src/onboarding/**`, `src/ui/orchestrate-*.ts`, `src/ui/sub-agent-*.ts`, `src/styles/orchestrate-*.css`, `src/styles/orchestrator-boards.css`, `src/styles/sub-agent-drawer.css`, `src/styles/plan-progress.css`, `src/styles/onboarding.css`, `src/styles/ob-page.css`, `src/styles/workspace-gate.css`, `src/styles/workspace-welcome-page.css`, `src/styles/workspace-folder-picker.css`, `src/styles/dev-server-screen.css`, `src/styles/device-request-prompt.css`, `src/styles/question-cards.css`, `src/styles/tool-approval.css`, `src/styles/agent-*.css`, `scripts/design-consistency-baseline.json`
- **Depends on:** W5-I

#### Task W5-K: Hidden apps (Compare, Bench, Experts, Research)
- **Build:** Migrate `src/compare/**`, `src/benchmark/**`, `src/ui/benchmark*`, `src/research/**` UI and `src/styles/{compare,benchmark-page,experts-*,research-*}.css`. These stay `releaseState: 'hidden'`; only their controls change.
- **Test:** `npm run test:benchmark` and `npm run test:research` pass; baseline updated.
- **Accept:** No released or hidden app defines its own button family.
- **Touches:** `src/compare/**`, `src/benchmark/**`, `src/ui/benchmark*`, `src/research/**`, `src/styles/compare.css`, `src/styles/benchmark-page.css`, `src/styles/experts-*.css`, `src/styles/research-*.css`, `scripts/design-consistency-baseline.json`
- **Depends on:** W5-J

### Wave 6 — Cleanup (Phase 4)

#### Task W6-A: Remove legacy aliases and duplicate button families
- **Build:** Remove the legacy class aliases added in Wave 4 (`settings-switch*`, `app-dialog-panel__btn*`) once `grep` finds no consumers; replace remaining `var(--radius-sm/md/lg)` with `var(--mn-radius-*)` and delete the aliases from `tokens.css`; delete `--scc-text-*` aliases; delete every `*-btn`/`*-button` class still defined outside `src/styles/components/` that the checker reports.
- **Test:** `npm test`, `npx tsc --noEmit`, `npm run build` and `npm run check:performance-budgets` pass; entry CSS size is at or below the pre-migration baseline in `scripts/bundle-size-baseline.json`.
- **Accept:** `grep -rn "var(--radius-" src` returns nothing.
- **Touches:** `src/styles/**`, `src/ui/settings-switch.ts`, `src/ui/app-dialog.ts`, `scripts/design-consistency-baseline.json`, `scripts/bundle-size-baseline.json`
- **Depends on:** W5-K

#### Task W6-B: Lock the check at zero and finalize docs
- **Build:** In `scripts/check-design-consistency.mjs`, turn every rule whose baseline total is zero into an absolute rule (any occurrence fails, no baseline entry needed). Document any intentional remaining exceptions inline with a `design-exempt: <reason>` comment the checker honours. Refresh `DESIGN.md`, `documentation/design-system/*.md` and `.impeccable/design.json` from the final state, and remove the "Extraction candidates" and legacy sections from `primitives.md`.
- **Test:** `npm run check:design-consistency` passes with an empty or near-empty baseline; `test/scripts/check-design-consistency.test.mjs` gains a case for `design-exempt`.
- **Accept:** The baseline file lists only documented exemptions.
- **Touches:** `scripts/check-design-consistency.mjs`, `scripts/design-consistency-baseline.json`, `test/scripts/check-design-consistency.test.mjs`, `DESIGN.md`, `documentation/design-system/**`, `.impeccable/design.json`
- **Depends on:** W6-A

## Verification Checklist
- [ ] `npm test` passes (scoped to touched areas; a few suites fail on clean main, see AGENTS.md)
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` and `npm run check:performance-budgets` pass with no budget raised
- [ ] `npm run check:design-consistency` passes and its baseline only shrinks
- [ ] `npm run impeccable:detect` reports no new anti-patterns
- [ ] The gallery renders every component in all 16 themes without console errors
- [ ] Each migrated surface is screenshot-compared in swamp-dark and one light theme

## Notes for Build Agents

**Literal → token mapping.** Font size: 9px, 9.5px, 10px, 0.625rem → `--mn-type-2xs`; 10.5px, 11px, 0.6875rem → `xs`; 11.5px, 12px, 0.75rem → `sm`; 12.5px, 13px, 0.8125rem → `md`; 13.5px, 14px, 0.875rem → `base`; 14.5px, 15px → `lg`; 15.5px, 16px, 1rem → `xl`; 17px, 18px → `2xl`; 19–21px → `3xl`; 22–24px → `4xl`; 25px and up → `display`. Other rem values map to the nearest pixel step (half steps round up, for legibility). Radius: 2–4px → `xs`; 5–7px → `sm`; 8–11px → `md`; 12–16px → `lg`; 18–22px → `xl`; 999px/9999px → `pill`. Spacing: snap 1px to a hairline only for borders, otherwise odd values (3, 5, 7, 9, 11, 13px) snap to the nearest half step. Weight: 550 → 500; 650 and 700 → 600. Line height: 1.45 → `normal`, 1.4 → `snug`, 1.25 → `tight`, 1.55 → `normal`.

**Do not migrate by find-and-replace across the repo.** Each surface task owns its files; the snapped values must be checked visually, and dense instrument surfaces (stats strip, issue rows, git graph) must keep their row heights.

**Component conventions.** Factories take one options object and return real elements (or a small handle when there is state to drive). No global init step, no framework, no shadow DOM. Every interactive element has an accessible name, a visible `:focus-visible` ring (`--mn-focus-ring`, `--mn-focus-ring-width`, `--mn-focus-ring-offset`), a 44px target under `(pointer: coarse)`, and hover styles only inside `(hover: hover) and (pointer: fine)`. Motion is transitions on colour, border, opacity and transform only; nothing animates at rest.

**Overlays.** Popover, tooltip and dialog roots call `markOverlayRoot()` (which sets `data-above-shell-overlay` and marks a preview occluder) and unmark on close. Use `--mn-z-*` layers, never a new number. Native `<dialog>.showModal()` is deliberately not used: it would put dialogs in the top layer above every existing menu and toast, which breaks the layering the rest of the app relies on until Wave 4-C lands.

**Tests.** `npm run test:components` runs every component suite plus the theme contrast check. `test/run-all.mjs` takes `--suite`, not file paths; to run individual files use `node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs --import ./test/assert-dom-safe.mjs --test --test-force-exit <files>` (the single-file run). `.test.mts` files run under the `tsx-mocks-loader` runner, which stubs `.css` imports. happy-dom has no layout, so placement logic is tested through `computeFloatingPosition` with fixed rectangles. Never `assert.equal` a happy-dom node against null/another node (it can exhaust memory); compare booleans or ids. Add `--test-force-exit` when running a UI suite directly with `node --test`.

**Bundle budgets.** A component costs nothing until imported. Migrations must delete the surface's old rules in the same change; if a migration grows total assets, it is doing it wrong.

**Shared live data.** A dev preview shares `~/.minnow` with the running app, so do not edit real records while checking a surface; use the gallery for component work.
