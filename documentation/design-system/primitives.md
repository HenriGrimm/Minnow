# UI primitives

**New controls come from the component library** in [`src/ui/components/`](../../src/ui/components/): Button/IconButton, Tooltip, Switch, input/textarea/select/checkbox/Field, SegmentedControl, Tabs, Badge/Chip, Popover and Dialog. See [components.md](components.md).

The classes and factories below are the **existing per-surface primitives**. They keep working, and [the migration plan](../plans/design-system-component-library.md) moves them onto the library surface by surface. Do not add new `*-btn` families or copy these patterns into new code.

## Buttons

| Class | Size | File | Behavior |
|-------|------|------|----------|
| `.icon-btn` | 40×40 | [`topbar.css`](../../src/styles/topbar.css) | Transparent + 1px border; fine-pointer hover inverts to accent fill |
| `.send-btn` | 44×44 | [`input.css`](../../src/styles/input.css) | Primary send/stop; accent fill, `--radius-md` |
| `.input-inset-btn` | inset | [`input.css`](../../src/styles/input.css) | Attach, voice inside composer |
| `.chat-new-wide` / `.chat-new-compact` | — | [`sidebar.css`](../../src/styles/sidebar.css) | Outlined new-chat CTA |
| `.settings-action-btn` | — | [`settings-controls.css`](../../src/styles/settings-controls.css) | Ghost; `--primary` and `--mn-danger` variants |

**States:** default, hover (`(hover: hover) and (pointer: fine)`), `:focus-visible` (2px `--mn-focus-ring`), `:disabled` (reduced opacity), active scale on send.

## Chips and badges

| Class | File | Use |
|-------|------|-----|
| `.stat-chip` + `.c` `.g` `.y` `.r` | [`messages.css`](../../src/styles/messages.css) | Per-message inference metrics (9px uppercase mono) |
| `.stats-cell` semantic classes | [`stats.css`](../../src/styles/stats.css) | Desktop metrics strip |
| `.issues-label[data-swatch]` | [`issues.css`](../../src/styles/issues.css) | Issue label chips; catalog color via `--mn-label-*` |

Semantic chip letters: **c** = accent, **g** = success, **y** = warning, **r** = danger.

## Inputs and forms

| Class / factory | File | Use |
|-----------------|------|-----|
| `#msgInput`, `.input-bar` | [`input.css`](../../src/styles/input.css) | Chat composer |
| `.settings-input`, `.settings-select`, `.settings-textarea` | [`settings-controls.css`](../../src/styles/settings-controls.css) | Settings fields |
| `.settings-row` | [`settings-controls.ts`](../../src/ui/settings-controls.ts) | Label + control row |
| `.settings-segment` | [`settings-controls.css`](../../src/styles/settings-controls.css) | Segmented control |
| `.settings-toggle-row` | [`settings-controls.css`](../../src/styles/settings-controls.css) | Boolean toggle |

**Focus:** border `--mn-accent`; `caret-color: var(--mn-fg)` on text inputs (MIN-168).

## Message surfaces

| Class | File | Use |
|-------|------|-----|
| User bubble | [`messages.css`](../../src/styles/messages.css) | `background: var(--mn-accent-soft)` |
| Assistant bubble | [`messages.css`](../../src/styles/messages.css) | `--mn-bg` + 1px `--mn-border`, squared corner toward speaker |
| `.tool-call-*` | [`messages.css`](../../src/styles/messages.css) | Tool invocation blocks |
| `.thought-*` | [`thoughts.css`](../../src/styles/thoughts.css) | Extended thinking UI |

## Navigation rows

| Class | File | Use |
|-------|------|-----|
| `.chat-item-row` | [`sidebar.css`](../../src/styles/sidebar.css) | Session list; hover `--mn-surface-elevated`, active accent border |
| `.chat-item-dot` | [`sidebar.css`](../../src/styles/sidebar.css) | Streaming / error status dot |

## Feedback

| Class | File | Use |
|-------|------|-----|
| `.mn-toast` + `--success` / `--error` | [`toast.css`](../../src/styles/toast.css) | Ephemeral notifications ([`toast.ts`](../../src/ui/toast.ts)) |
| `.memory-saved-toast` | [`memory-saved-toast.css`](../../src/styles/memory-saved-toast.css) | Queued memory confirmation with reject/open actions and expiry progress ([`memory-saved-toast.ts`](../../src/ui/memory-saved-toast.ts)) |
| `.visually-hidden` | [`global.css`](../../src/styles/global.css) | Screen-reader-only |
| `.icon-svg` | [`global.css`](../../src/styles/global.css) | 18px stroke icons |

## Settings DOM factories

[`settings-controls.ts`](../../src/ui/settings-controls.ts) builds:

- `createSettingsRow()` — label + control column
- `createSettingsSelect()`, `createSettingsInput()`, `createSettingsTextarea()`
- `createSettingsSegment()`, `createSettingsToggleRow()`
- `createSettingsGroup()` — bordered group with title

Used across Settings, Compare, Scheduler, and other settings-like surfaces.

## Mode icons

`.mode-mask-icon` in [`mode-icons.css`](../../src/styles/mode-icons.css) — CSS mask icons tinted with `--mn-fg` / accent per operating mode.

## Extraction candidates (not yet shared)

These repeat twice but differ in context. Extract one into `src/ui/components/` only when a third identical use appears:

- App-specific page headers (Research, Brain)
- Orchestrate board card chrome (domain-specific layout)
- Benchmark chart legends (data-viz specific)
