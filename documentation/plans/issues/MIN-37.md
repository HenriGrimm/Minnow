# MIN-37: Simplify the preview toolbar

## Plan

1. Keep navigation, address entry, expand, and close visible in primary and split preview panes.
2. Put History, Auto-reload, Design Mode, annotations, DevTools, docking, and split into the existing More menu with readable labels and toggle state.
3. Reuse each original control's event handler so actions retain current behavior and capability gating.
4. Keep the menu usable in browser fallback, with Electron-only actions shown only when available.
5. Support keyboard navigation, Escape dismissal, and focus return; verify forwarding and both pane variants with focused tests.

## Acceptance

- The primary toolbar no longer displays the long row of secondary tools.
- Every existing tool remains available through More when supported.
- Both primary and secondary preview menus work without Electron.
- Native browser actions continue using the active pane's tab and instance.
