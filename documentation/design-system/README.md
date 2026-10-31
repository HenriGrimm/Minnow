# Minnow design system (current state)

Living inventory of Minnow's UI layer as implemented in code. The design system is **CSS tokens** (palette plus type, spacing, radius, control and layer scales), a **framework-free component library** in [`src/ui/components/`](../../src/ui/components/) with one stylesheet per component in `src/styles/components/`, and the feature modules (`src/ui/`, `src/os/`) and stylesheets that build on them.

**North star:** Calm local instrument — conversation first, metrics as instrumentation, borders instead of card stacks.

## Authoritative sources

| Layer | Path |
|-------|------|
| Palette and scale tokens (hex/rgba only here) | [`src/styles/tokens.css`](../../src/styles/tokens.css) |
| Component library | [`src/ui/components/`](../../src/ui/components/) + `src/styles/components/` — see [components.md](components.md) |
| Theme runtime | [`src/theme.ts`](../../src/theme.ts) → [`src/ui/theme.ts`](../../src/ui/theme.ts) |
| Custom overrides | [`src/appearance/types.ts`](../../src/appearance/types.ts), [`custom-theme.ts`](../../src/appearance/custom-theme.ts) |
| Shared settings primitives | [`src/ui/settings-controls.ts`](../../src/ui/settings-controls.ts) + [`settings-controls.css`](../../src/styles/settings-controls.css) |
| Dropdowns and menus | [`dropdowns.css`](../../src/styles/dropdowns.css), `--mn-menu-*` in [`tokens.css`](../../src/styles/tokens.css), [`context-menu.ts`](../../src/ui/context-menu.ts) |
| Global primitives | [`global.css`](../../src/styles/global.css), [`topbar.css`](../../src/styles/topbar.css), [`input.css`](../../src/styles/input.css), [`messages.css`](../../src/styles/messages.css), [`stats.css`](../../src/styles/stats.css) |
| Minnow Shell | [`minnowos-tokens.css`](../../src/styles/minnowos-tokens.css), [`src/os/`](../../src/os/) |
| Human spec | [`DESIGN.md`](../../DESIGN.md), [`PRODUCT.md`](../../PRODUCT.md) |
| Machine sidecar | [`.impeccable/design.json`](../../.impeccable/design.json) |

## Documentation map

| Doc | Contents |
|-----|----------|
| [tokens.md](tokens.md) | `--mn-*` catalog, scale tokens, layout/motion tokens, derived semantics |
| [components.md](components.md) | Shared component library: API, keyboard model, ARIA contract, gallery |
| [themes.md](themes.md) | 16 palette themes, storage keys, customization |
| [primitives.md](primitives.md) | Buttons, chips, inputs, settings controls, toast |
| [dropdowns.md](dropdowns.md) | Shared menu tokens, native selects, custom menus, keyboard focus |
| [layout-shell.md](layout-shell.md) | Top bar, sidebar, composer, stats strip, breakpoints |
| [shell.md](shell.md) | Minnow Shell, `--os-*` aliases, wallpaper |
| [css-map.md](css-map.md) | Stylesheet → feature mapping |

## Architecture

```
tokens.css (16 themes × --mn-* colours + scale tokens)
    ↓
src/ui/components/ + src/styles/components/ (shared primitives)
    ↓
global.css + feature CSS, src/ui/*.ts (surfaces built from primitives)
    ↓
index.html shell + Minnow (src/os/)
```

## Rules (carry everywhere)

1. **Hex/rgba literals** only in `tokens.css`. Application CSS uses `--mn-*` (or `--os-*` in the shell).
2. **Metric colors** (`--mn-success`, `--mn-warning`, `--mn-danger`) are for instrumentation and status only, never navigation chrome.
3. **Flat chrome** at rest: top bar, sidebar, input bar, stats strip use borders, not box-shadow.
4. **No nested cards** in chat or settings.
5. **Anti-patterns:** neon HUD, ChatGPT-clone cream/purple, hero-metric dashboards, glassmorphism, gradient text, colored `border-left` stripes.

## Gaps tracked (code vs older docs)

| Item | Was documented | Code reality |
|------|----------------|--------------|
| Color model | Single OKLCH light palette | 16 hex-based families in `tokens.css` |
| Default theme | Light-first | **`swamp-dark`** (`DEFAULT_THEME_ID` in `theme.ts`) |
| Sidebar width | 240px | **`--sidebar-w: 300px`** in `tokens.css` |
| Core tokens | 22 variables | **26** in `CORE_THEME_TOKEN_KEYS` |
| User bubbles | Fixed bench green | **`--mn-accent-soft`** per family |
| Legacy aliases | `--text`, `--accent` | Prefer `--mn-fg`, `--mn-accent`; some files still fall back |

Extracted: July 2026 via Impeccable `extract`.
