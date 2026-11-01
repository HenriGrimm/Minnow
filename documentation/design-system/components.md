# Component library

Shared controls live in [`src/ui/components/`](../../src/ui/components/). Each component is a TypeScript factory that returns real DOM elements (or a small handle when there is state to drive) and imports its own stylesheet from [`src/styles/components/`](../../src/styles/components/). There is no framework, no global init step and no shadow DOM, so a component drops into any existing surface.

Import from the barrel:

```ts
import { createButton, createIconButton, openDialog } from '../ui/components';
```

The barrel also re-exports the older shared primitives so surfaces have one import path: `openContextMenu`/`closeContextMenu` (action menus), `notify`/`showToast` (notification cards) and `createIcon`.

A component costs nothing until a surface imports it, because its CSS travels with its module.

Code controls use `appearance: 'surface'` to retain their established sizing, colors, spacing and states while sharing the component factories, accessibility and event handling. The resulting `data-mn-surface` marker excludes those controls and their children from the default component skin. Their existing surface CSS remains responsible for their appearance. Other surfaces keep the default skin.

Factories accept an existing `element` when its identity, children or listeners must survive adoption. `adoptControls(root, { appearance: 'surface' })` and `adoptTabs(root, { appearance: 'surface' })` apply the same contract to static controls. Surface popovers reuse the content root; `portal: false` retains its existing CSS anchor and containing block while sharing dismissal, focus restoration and preview occlusion.

**Gallery:** start the Vite dev server (`npm run dev -- --port 5173 --strictPort`) and open `http://localhost:5173/test/fixtures/components-gallery.html`. It renders every component, variant and state, with a theme switcher for all 16 themes (`?theme=coral-light` works too) and a narrow-width toggle.

**Tests:** `npm run test:components`.

## Shared rules

- Every interactive element has an accessible name, a visible `:focus-visible` ring (`--mn-focus-ring`, 2px, 2px offset), and a 44px target under `(pointer: coarse)`.
- Hover styles live inside `(hover: hover) and (pointer: fine)`.
- Motion is limited to transitions on colour, border, opacity and transform. Nothing animates at rest. The busy spinner runs only while a button is busy and stops under reduced motion.
- Sizes come from the scale tokens (`--mn-control-h-*`, `--mn-type-*`, `--mn-space-*`, `--mn-radius-*`). Component CSS contains no colour literals.
- Floating roots (tooltip, popover, dialog) set `data-above-shell-overlay`, so shell overlays do not treat clicks inside them as outside clicks. They are also marked as preview occluders (`markPreviewOccluder`), so the native preview steps aside. Layers: `--mn-z-dialog` < `--mn-z-popover` < `--mn-z-tooltip`, so popovers and tooltips work inside dialogs.
- Every text and background pair a component owns meets WCAG AA (4.5:1) in all 16 themes. The palette's `--mn-fg-on-accent` on `--mn-accent` pair (primary buttons) is guarded by `test/theme-contrast.test.mts`.

## Button and IconButton

`createButton(options)` returns an `HTMLButtonElement`. `createIconButton(options)` returns a square, icon-only button.

| Option | Values | Default |
|--------|--------|---------|
| `variant` | `primary`, `secondary`, `ghost`, `danger` | `secondary` (icon buttons: `ghost`) |
| `size` | `sm` 28px, `md` 32px, `lg` 40px | `md` |
| `label`, `icon`, `iconEnd` | Text and leading or trailing icon (`IconName`) | none |
| `pressed` | Makes a toggle button (`aria-pressed`) | not a toggle |
| `block` | Full width | false |
| `type` | `button`, `submit`, `reset` | `button` |
| `tooltip` | Tooltip text (icon buttons: `false` to suppress, or custom text) | icon buttons use the label |

For icon buttons, `label` is required: it becomes the accessible name and the tooltip.

Helpers: `setButtonBusy(button, busy)` disables the button and shows a spinner while keeping its width, then restores the prior disabled state. `setButtonPressed(button, pressed)` and `setButtonLabel(button, label)` update state and text (for icon buttons, `setButtonLabel` updates the name and tooltip).

- **Primary:** the one main action in a region. Do not place two side by side.
- **Secondary:** ordinary actions.
- **Ghost:** toolbar and inline icon actions.
- **Danger:** destructive actions. In a confirm dialog, give initial focus to Cancel.

## Tooltip

`attachTooltip(target, text, { placement })` returns a detach function. One shared `role="tooltip"` element shows after `TOOLTIP_DELAY_MS` (400ms) on mouse hover and immediately on keyboard focus. It hides on leave, blur, pointer down, scroll and Escape. Touch never shows it.

While the tooltip is visible, `aria-describedby` links it to its target. The link is skipped when the text equals the target's `aria-label`, so screen readers don't announce it twice. Attaching removes any native `title` attribute.

Use `setTooltip(target, text)` to change the text and `hideTooltip()` to dismiss it.

Use tooltips for icon-only controls and truncated text. Never put information that exists nowhere else into a tooltip.

## Switch

`createSwitch(options)` returns `{ root, input }`. The input is a real checkbox with `role="switch"`, so forms and `change` listeners work unchanged. Sizes are `md` (40×22 track, matching the settings switch) and `sm`. Name it with `ariaLabel`, or point `labelledBy` at a visible label.

Use a switch for settings that apply immediately. Use a checkbox for choices that are submitted later.

## Form controls and Field

| Factory | Returns | Notes |
|---------|---------|-------|
| `createTextInput(options)` | `HTMLInputElement.mn-input` | `size` sm/md/lg, `type`, `placeholder`, `invalid`, `onInput`, `onChange` |
| `createTextarea(options)` | `HTMLTextAreaElement` | `rows` (default 3), `resize: 'none'` |
| `createSelect(options)` | Native `HTMLSelectElement.mn-select` | Border, radius and the themed popup come from `dropdowns.css` |
| `createCheckbox(options)` | `{ root, input }` | Optional `description` line, linked by `aria-describedby` |
| `createField(options)` | `{ root, label, hint, error, setError, setHint }` | Wraps any of the above |

`createField` links the label to the control (`for`/`id`, generating an id if needed). It adds the hint and the visible error to `aria-describedby` and sets `aria-invalid` while an error is shown. `required` sets the control's `required` attribute and adds a decorative asterisk.

Under coarse pointers, inputs use 16px text so iOS does not zoom.

## SegmentedControl

`createSegmentedControl({ options, value, ariaLabel, size, onChange })` returns `{ root, getValue, setValue, setDisabled }`.

It is a `radiogroup` with one Tab stop. Arrow keys move and select, skipping disabled options, and Home/End jump to the first and last option. `setValue(v, { silent: true })` updates the control without calling `onChange`. Options can be icon-only (`iconOnly: true` keeps the label as the accessible name).

Use it for two to five mutually exclusive views or modes that switch instantly. Use a select for longer lists.

## Tabs

`createTabs({ tabs, selected, ariaLabel, activation, variant, onChange })` returns `{ root, list, select, getSelected, setCount, setDisabled }`.

It follows the WAI-ARIA tabs pattern: `tablist`/`tab`/`tabpanel`, `aria-selected`, `aria-controls`, and roving `tabindex`. Arrow keys and Home/End move between tabs.

- **Activation:** `auto` (default) selects as focus moves. Use `manual` when switching panels is expensive; Enter or Space then selects.
- **Panels:** pass a `panel` element per tab and the component shows and hides it. Without panels, swap content yourself in `onChange`.
- **Counts:** `count` shows a small number after the label; update it with `setCount`.
- **Variants:** `underline` (default) for panes and pages, with an accent rule under the selected tab. `contained` for tabs inside a card or toolbar.

## Badge and Chip

`createBadge({ label, tone, size, dot, icon, mono })` creates a read-only status label. Tones are `neutral`, `accent`, `success`, `warning` and `danger`. Use `mono` for metrics and counts (tabular numbers).

Success, warning and danger are for status and measurement only (Metric Color Rule). Use neutral or accent for categories.

`createChip({ label, tone, icon, onClick, selected, onRemove })` creates a token:

- **Passive:** no `onClick`.
- **Toggle:** with `onClick`, the chip is a button with `aria-pressed`; update it with `setChipSelected`.
- **Removable:** `onRemove` adds a separate remove button named "Remove {label}". It is never nested inside the toggle button.

## Popover

`openPopover({ anchor, content, placement, ariaLabel, matchAnchorWidth, initialFocus, onClose })` returns `{ root, close, reposition, isOpen }`. `togglePopover(options)` opens a popover, or closes it if one is already open for that anchor. Use it in anchor click handlers.

- **Use:** pickers, small forms and detail panels tied to a control. For lists of actions, use `openContextMenu`.
- **Placement:** below the anchor by default, flipping above it when it would clip, clamped to the viewport, and repositioned on resize and scroll.
- **Anchor state:** the anchor gets `aria-expanded` and `aria-controls`.
- **Focus:** moves to the first focusable element inside, unless `initialFocus` says otherwise. It returns to the anchor on Escape.
- **Nesting:** popovers can nest. Escape closes only the topmost. A pointer press outside closes every popover it lands outside of. Presses inside `.mn-menu` and `.mn-tooltip` count as inside. While a context menu is open, Escape belongs to the menu.

## Dialog

`openDialog({ title, description, body, actions, size, dismissible, closeButton, initialFocus, onClose })` returns `{ overlay, panel, body, footer, close, closed, setBusy }`. `closed` resolves with the chosen action id, or `null` when the dialog is dismissed.

- **Use:** custom modal content. For one-line flows, keep `appAlert`/`appConfirm`/`appPrompt` from `src/ui/app-dialog.ts`.
- **Sizes:** `sm` 360px, `md` 28rem (default), `lg` 640px, capped to the viewport.
- **Actions:** buttons in the footer. A `run` that returns or resolves `false` keeps the dialog open. An async `run` shows the clicked button as busy and disables the other actions until it settles.
- **Focus:** initial focus goes to `initialFocus`, then the `autoFocus` action, then the first control in the body, then the first action, then the panel. Tab is trapped in the topmost dialog, and focus returns to the opener on close.
- **Dismissal:** Escape, the scrim (only when the press both starts and ends on it) and the close button dismiss when `dismissible` (default true). With several dialogs open, only the topmost reacts.

The dialog is a fixed overlay on `--mn-z-dialog`, not `<dialog>.showModal()`. The browser's top layer would sit above every existing menu and toast.

## Placement helpers

`computeFloatingPosition(anchorRect, size, viewport, { placement, offset, edgeGap })` is the pure placement math: preferred side, flip, clamp. `placeFloating(el, anchor, options)` measures the elements and writes `left`/`top` for a `position: fixed` element. Use them for custom floating UI instead of writing new placement code.
