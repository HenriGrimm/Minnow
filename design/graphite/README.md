# Graphite design export

This folder is a full export of the Graphite workspace redesign canvas: every board, the shared stylesheet, the canvas layout and the icons the boards use.

| | |
|---|---|
| **Source** | https://claude.ai/artifact/2JzcfVNSHbbraMYsQ2ugca (private Design artifact) |
| **Exported** | 2026-11-09, from version `1794261255-4921` |
| **Implementation guide** | [documentation/plans/graphite-workspace-redesign.md](../../documentation/plans/graphite-workspace-redesign.md) |

The boards are the spec for layout, spacing, copy and interaction. Minnow's code stays the spec for data, persistence and tools.

## What's here

- `project/`: the canvas files exactly as published.
  - `Main.dc.html`: the whole desktop prototype. Every 1440×900 board is a view of it, opened at a `start` state.
  - `Composer.dc.html`, `Mobile.dc.html` and the other large boards are standalone components.
  - `graphite.css`: the shared tokens and component styles. Theme families and Color intensity are driven by `--tint` and `--tint-c`.
  - `canvas.json`: board positions, titles and the notes on the canvas.
- `assets/`: the 44 Material file icons the boards load as `/_blob/<id>`. Each file is named by its blob id.
  - `assets/manifest.json` maps each `/_blob/<id>` to its icon name.
  - The icons are Minnow's own `public/material-icons`.

## Reading a board

Each `.dc.html` is HTML with a small template layer:
- `{{path}}` holes, `sc-if` and `sc-for` blocks, and `dc-import` for nesting another board;
- behaviour in a `<script type="text/x-dc">` class whose `renderVals()` returns everything the markup binds.

For layout, read the markup. For behaviour, read `renderVals()` and the class methods, for example:
- `dockState`, `openSurface` and `moveSurface` for the side and bottom panels;
- `toggleTerminal` for Ctrl+`;
- the `sc` object for the source control surface;
- the `card` object for the thread card.

## Viewing the boards

The boards don't open as plain files. They need the Design artifact runtime (`support.js`), which is not part of this export. To view or edit them, open the source link above, or publish `project/` back into a Design artifact.

## Start states

Views of `Main` open at a `start` string:
- `thread:<id>` opens a thread, and `thread:<id>:card` opens its thread card.
- `thread:<id>:launch[:bottom]` opens a panel's launcher.
- `thread:<id>:<surface>[+<surface>][:bottom|:right|:full]` opens surfaces. Terminal goes to the bottom panel by default, and everything else to the side.
- App screens: `new`, `issues`, `archive`, `palette`, `search`, `keys`, `capture`, `fork`, `resume`, `issues:projects`, `app:settings`.

## Boards

| File | Title | Start state | Size |
|------|-------|-------------|------|
| `Main.dc.html` | Prototype: click anything, drag any panel edge | — | 1440×900 |
| `Workspaces.dc.html` | Choose a workspace: open, create, clone | — | 1440×900 |
| `Approval.dc.html` | Approval, with the Agents surface open | `thread:perm:agents` | 1440×900 |
| `Changes.dc.html` | Ready to commit, Diff surface open | `thread:shimmer:changes` | 1440×900 |
| `NewThread.dc.html` | New thread | `new` | 1440×900 |
| `Issues.dc.html` | Issues on the same sheet | `issues` | 1440×900 |
| `Archive.dc.html` | Archive | `archive` | 1440×900 |
| `Command.dc.html` | ⌘K command menu | `palette` | 1440×900 |
| `SourceControl.dc.html` | Source control: AI commit, review, PRs, releases | — | 1168×836 |
| `Models.dc.html` | Models: my models, Discover, pools, usage | — | 1168×836 |
| `Boards.dc.html` | Boards: waves, worktrees, gates | — | 1168×836 |
| `Brain.dc.html` | Brain: graph, proposals, code map | — | 1168×836 |
| `Scheduler.dc.html` | Scheduler: jobs, editor, live run | — | 1168×836 |
| `Settings.dc.html` | Settings: every group and page | — | 1168×836 |
| `Preview.dc.html` | Preview: dev servers, Design Mode, Agent Browser | — | 1168×836 |
| `Composer.dc.html` | Composer: Minnow's own, with the new model menu | — | 760×560 |
| `Notify.dc.html` | Notifications: cards, Activity, alerts | — | 1168×836 |
| `Mobile.dc.html` | Phone prototype: tap anything | — | 390×844 |
| `Phones.dc.html` | Every phone surface | — | 4428×1000 |
| `Search.dc.html` | Search chats: threads, messages, issues (⌘F) | `search` | 1440×900 |
| `Shortcuts.dc.html` | Keyboard shortcuts (?) | `keys` | 1440×900 |
| `Capture.dc.html` | Capture issue from a thread (⌘I) | `capture` | 1440×900 |
| `Goal.dc.html` | Goal loop: evaluator, rounds, compaction divider | `thread:offline:goal` | 1440×900 |
| `Recovery.dc.html` | Failed turn: retry, continue, or fork | `thread:brain` | 1440×900 |
| `Fork.dc.html` | Fork with different model | `fork` | 1440×900 |
| `Resume.dc.html` | Resume interrupted work? | `resume` | 1440×900 |
| `IssueProjects.dc.html` | Issues › Projects | `issues:projects` | 1440×900 |
| `ThreadCard.dc.html` | Thread card (⌘.): where it runs, branch, commit, model, permissions | `thread:gating:card` | 1440×900 |
| `Surfaces.dc.html` | Open a surface: one letter each, greyed when it doesn’t apply | `thread:gating:launch` | 1440×900 |
| `BottomDock.dc.html` | Side panel and bottom panel open together | `thread:gating:preview+terminal` | 1440×900 |
| `PullRequest.dc.html` | Pull request surface on the CI thread | `thread:ci:pr` | 1440×900 |
| `SideChat.dc.html` | Side chat: a read-only /ask next to the thread | `thread:gating:side` | 1440×900 |
| `ThemeOcean.dc.html` | Ocean theme, rich color | `thread:gating:agents` (theme ocean, tint rich) | 1440×900 |
| `ThemeDesert.dc.html` | Desert theme, light mode, subtle color | `thread:shimmer:changes` (theme desert, light, tint subtle) | 1440×900 |
| `Appearance.dc.html` | Settings › Appearance: theme, color, accent | `app:settings` (theme human, tint subtle) | 1440×900 |
