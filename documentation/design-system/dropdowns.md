# Dropdowns and menus

Dropdowns use the same theme-aware surface across Code, Settings, Issues, Models,
Source Control, boards, and shell menus. Tokens live in `src/styles/tokens.css`;
native select styling and reusable classes live in `src/styles/dropdowns.css`.

| Token | Purpose |
|---|---|
| `--mn-menu-radius` | Panel corners, 14px |
| `--mn-menu-item-radius` | Inset row corners, 10px |
| `--mn-menu-padding` | Panel inset, 6px |
| `--mn-menu-item-padding` | Row padding, 7px 10px |
| `--mn-menu-item-height` | Minimum desktop row height, 34px |
| `--mn-menu-bg` | Opaque menu surface, derived from `--mn-surface-1` |
| `--mn-menu-border` | Panel border, derived from `--mn-border` |
| `--mn-menu-hover-bg` | Hover fill, derived from `--mn-surface-elevated` |
| `--mn-menu-selected-bg` | Selection fill, derived from `--mn-accent-soft` |
| `--mn-menu-shadow` | Shared elevation, derived from the theme's shadow color |

## Choosing a control

Use a native `<select>` for a single value. No new JavaScript wiring is needed:
the stylesheet covers controls created by lazy modules, keeps the native value,
labels, disabled options, groups, keyboard navigation, and change events, and
styles both the closed control and its popup. Electron and browser clients with
`appearance: base-select` support get a rounded themed popup. Other browsers
retain their native picker. Multi-select and `size` listboxes keep their existing
layout. Hidden `.model-select-native` backing controls remain hidden.

`installThemedSelects()` adds a native `<button><selectedcontent>` face in
supporting clients so long labels can truncate without moving the arrow or
growing the control. It handles lazy controls and option replacement, preserves
existing custom buttons, and leaves option collections and selection events
unchanged. The observer processes affected controls rather than rescanning the
app after every DOM update.

Use `openContextMenu()` from `src/ui/context-menu.ts` for action menus. It owns
keyboard navigation, typeahead, submenus, separators, and focus restoration. Its
CSS consumes the same menu tokens as native selects and existing custom pickers.

For a custom picker with specialized content, use `.mn-dropdown` for the surface
and `.mn-dropdown__item` for rows, or consume these tokens in its feature CSS.
Feature styles own placement, width, scrolling, and content layout. A list inside
a styled popover keeps its own panel border and shadow off; only the outer panel
owns the shell. Do not apply dropdown classes to entire app listboxes or grids.

## States and accessibility

Use `--mn-fg` text and `--mn-fg-muted` secondary text. Selected rows use the accent
fill with an accent border or a checkmark. Keyboard focus uses `--mn-focus-ring`;
disabled rows remain readable and cannot be selected. Coarse pointers use a 44px
row target. Keep hover treatments inside fine-pointer media queries and motion
behind the reduced-motion preference.

`installNativeSelectPreviewGuard()` in `src/ui/native-select-preview-guard.ts`
registers open styled select pickers with the existing chrome-popover registry.
This hides Electron's native browser guest while the renderer popup is open and
restores it on dismissal, including removal of the select. Plain browser clients
do not need the guard.

Minnow's design system is CSS tokens and TypeScript DOM components. Dropdown
consistency does not require a new UI framework or a second theme system.
