# Graphite layout

| Region | Owns | Code |
| --- | --- | --- |
| Workspace sidebar | Workspace switcher, app destinations, thread list, and footer controls | [graphite-workspace.ts](../../src/os/graphite-workspace.ts), [graphite-workspace.css](../../src/styles/graphite-workspace.css) |
| Thread header and stage | Thread card, checkout, collapse controls, transcript, and composer | [graphite-workspace.css](../../src/styles/graphite-workspace.css), [thread-card.ts](../../src/ui/thread-card.ts), [input.ts](../../src/ui/input.ts) |
| Side and bottom panels | Surface launcher, tabs, split state, and panel placement | [surfaces-column.ts](../../src/ui/surfaces/surfaces-column.ts), [graphite-context-surfaces.css](../../src/styles/graphite-context-surfaces.css) |
| Foreground apps | App stage, title bar, and back-to-chat control | [graphite-app-chrome.ts](../../src/os/graphite-app-chrome.ts), [graphite-apps.css](../../src/styles/graphite-apps.css) |

Keep the chat measure consistent across transcript, composer, and Metrics. Panel dividers should preserve an operable composer until the user maximizes a surface. File and browser tabs use the existing workbench content state.

For desktop changes, verify keyboard focus after resizing, moving, or closing a tab. Check the stage with both panels open and with the workspace sidebar hidden. For phone layouts, verify that a surface can open in a single sheet and return focus to its trigger when closed. Run with reduced motion before shipping a new transition.

See [Graphite shell](shell.md) for route boundaries and [tokens](tokens.md) for shared scales.
