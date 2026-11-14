# Graphite shell

Use the workspace sidebar for navigation and thread history. Keep thread-level controls in the header and compose optional work surfaces into the side or bottom panel.

| Change | Start here |
| --- | --- |
| Workspace picker and route transitions | [workspace-gate.ts](../../src/os/workspace-gate.ts) and [router.ts](../../src/os/router.ts) |
| Sidebar, workspace actions, and footer | [graphite-workspace.ts](../../src/os/graphite-workspace.ts) and [graphite-workspace.css](../../src/styles/graphite-workspace.css) |
| App stage and chrome | [graphite-app-chrome.ts](../../src/os/graphite-app-chrome.ts) and [graphite-apps.css](../../src/styles/graphite-apps.css) |
| Side, bottom, and phone surfaces | [Surface registry](../../src/ui/surfaces/surface-registry.ts) and [panel layout](../../src/ui/surfaces/surfaces-column.ts) |
| Shared palette and foreground states | [tokens.css](../../src/styles/tokens.css) and [shell token aliases](../../src/styles/minnowos-tokens.css) |

When a new menu, dialog, or notification overlaps a native preview, register it as a [preview occluder](../../src/ui/preview-occlusion.ts). Check keyboard focus after opening, closing, and moving a panel. Check a thread with both panels visible and the narrow layout that presents a single surface as a sheet. See [Apps and routes](../contributor/apps-and-routes.md) for entry points.
