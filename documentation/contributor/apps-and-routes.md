# Apps and routes

The workspace picker at `#/workspaces` opens a project in Code. Graphite mounts the workspace sidebar and command palette around Code's thread stage. The sidebar exposes Source Control, Issues, Brain, Automations, and Boards. Models, Settings, and the manual have their own controls in the workspace chrome. The [user manual](../manual/apps/overview.md) explains how to use them.

| Surface | Route or entry point |
| --- | --- |
| Code threads | `#/app/code/chat` |
| Dev servers | `#/app/code/dev-server` |
| Source Control | Sidebar button or `#/app/source-control` |
| Issues | `#/app/issues` with an optional issue ID |
| Models | `#/app/models/<section>` |
| Brain | `#/app/brain/<section>` |
| Automations | `#/app/scheduler` |
| Boards | Workspace sidebar or `#/app/code/boards` |
| Settings | `#/app/settings/<section>` |
| Manual | `#/wiki` |

## Change an entry point

1. Check [the router](../../src/os/router.ts) for hash parsing, redirects, and release gating. Old Code, chat, and Settings URLs still enter through the legacy hash resolver.
2. Check [the app registry](../../src/os/app-registry.ts) before adding a launcher entry. Release-gated app IDs can remain valid for stored data and tests. User navigation filters them by release state.
3. For workspace chrome and Code commands, use [the Graphite shell](../../src/os/graphite-workspace.ts). For a thread panel tab, use [the surface registry](../../src/ui/surfaces/surface-registry.ts) and [panel implementation](../../src/ui/surfaces/surfaces-column.ts).
4. Test the route from the workspace picker, then switch between threads. Graphite panel placement is tracked per workspace and thread. The phone layout projects one surface into a sheet.
5. Check command-palette navigation and update the corresponding user procedure if the entry point changes.

Settings labels and sidebar groups are in [settings-page-types.ts](../../src/ui/settings-page-types.ts). The Models UI owns the provider, routing, sampler, thinking, voice, and usage destinations. See [context.md](../context.md#major-apps-server--ui) for the backing modules.
