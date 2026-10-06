# Apps overview

Minnow is one shell built around **Code**. Everything else is a surface that supports the work you do there. There are no toggles, no marketplace and nothing to enable: what ships is installed and on, which removes an entire category of afternoon.

Home, Code, Source Control, Models, Brain, Issues and Scheduler sit on the left app rail; **Settings** opens from the menubar gear. They share one chat engine, one tool set, one session store, and one workspace folder at a time. Opening Brain does not start a different assistant — it gives the same assistant a different layout and workflow.

That sharing is the whole design, not a packaging detail. The assistant that reads your files is the one that files the issue, makes the branch, writes the Brain page, and runs on the model you downloaded — all pointed at the same folder. Nothing has to be told about your project twice.

Cold start opens the **workspaces picker** (`#/workspaces`). Choose a folder and Home opens. Select **Open Code** to start building. The menubar **workspace** control opens the same picker anytime.

Move between surfaces with **Ctrl+Tab** / **Ctrl+Shift+Tab**, or the left app rail. In the desktop app, right-click a rail tile (except Home and Code) to open that app in its own window; choosing it again focuses the window that is already open.

## Home

The selected project at a glance: pending questions, recent chats, boards, repository changes, issues, recent files, scheduled work, and a calendar of recorded AI code edits. Each item opens its working surface.

→ [Home app](home.md)

## Code

The surface you work in. Sessions in the chat rail on the left, composer in the middle, project files and editor on the right, with terminal, source control, dev servers and a real Chromium preview alongside. File and git tools resolve under the **workspace root** you opened here.

Two things live inside Code rather than beside it:

- **Orchestrate boards** — from the Orchestrate button in the Code sidebar rail.
- **Source Control Center** — the full git app, available in the navigation rail and from the source-control panel.

→ [Code app](code.md), [Your first chat](../get-started/first-chat.md), [Working in chat](../chat/chatting.md)

## The supporting surfaces

| Surface | What it is for | How it opens |
|-----|----------------|--------------|
| **Source Control** | Changes, history, branches, stashes, worktrees, pull requests and CI | Fullscreen |
| **Models** | What the agents run on: downloads, local serving, providers, routing, sampler, voice, usage | Fullscreen |
| **Issues** | Issue list and board with agent triage | Fullscreen |
| **Brain** | Your knowledge wiki, memories, ingest, lint, code index | Fullscreen |
| **Scheduler** | Recurring jobs on an interval or cron | Side panel |
| **Settings** | Everything configurable | Menubar gear (not on the app rail) |

**Scheduler** opens as a side panel over what you were doing, so you can add a job without leaving Code. The others take the main stage; **Settings** is always one click away in the menubar.

### Source Control history

Open **Source Control → History** to explore commits from local branches, remote branches, and tags. **Map** runs from older commits on the left to newer commits and HEAD on the right; **List** shows the same loaded commits chronologically. Minnow remembers the chosen view. Selecting a commit opens review below history, with horizontal file tabs and the same side-by-side parent/commit diff viewer used in Code. **Wrap** controls long lines, and closing review gives the map the full height.

Search loaded history by message, author, SHA, or ref, or filter by ref type. Choose a side branch and select **Collapse** to hide its interior commits; **Expand** restores them. Branch tips, joins, and the selected commit stay visible. **Load older** extends history in bounded pages. If refs change between pages, retry refreshes the graph.

In Map, drag or scroll to move horizontally, or drag the minimap. Branch rows stay centered vertically and retain their colors when zoomed out. Pinch or use the zoom buttons to change scale; **Fit** shows the whole shown map and **Reset** returns to HEAD. Polling and loading older pages preserve the viewed commit's position and zoom. Arrow keys on a commit move focus; **Home** finds HEAD, **End** finds the oldest shown commit, and **Enter** or **Space** selects. Focus the map background to move with left/right arrows and zoom with **+**, **−**, or **0** (fit). Right-click a commit for its existing Git actions. Left/right arrows on the file tabs switch the reviewed file.

### Models

Nine sections covering everything model-related: hardware-aware recommendations, downloaded artifacts, a Hugging Face library with local serving, voice models, providers, per-role routing, sampler defaults, thinking controls, and token usage with cost.

Routing is the part that matters most day to day: it binds models to roles — main chat, chat titles, research, review, the `/goal` evaluator, and each agent type — so one model does not have to do everything.

→ [Models app](models.md)

### Issues

Tracking that the agent can use: list and board views, quick capture, types, statuses, priorities and labels you define. Agents file and triage issues through `issue_*` tools, and an issue can be sent straight to a chat or an orchestrate board.

→ [Issues app](issues.md)

### Brain

Your own wiki in markdown, stored in your Minnow home. Graph view, page editing, an append-only log, a taxonomy schema, AI proposals awaiting review, memory entries, source ingest, a lint report, and a code-symbol index of your repositories.

The assistant reads and writes it with tools. This is where `save_memory` puts things.

→ [Brain app](brain.md)

### Scheduler

Interval or cron jobs that run a prompt in a chosen workspace with a chosen model through a headless runner. Run history, output and notifications are kept.

Jobs run **only while Minnow is running**. Hidden in the tray still counts; fully quit does not.

→ [Scheduler app](scheduler.md)

### Settings

Seven categories: General, Apps, Appearance, Models, Agents, Integrations, Advanced. Search with **Ctrl+K** / **Cmd+K** — results deep-link across apps, so a search for "memory" opens Brain.

→ [Settings app](settings.md)

## Not on the rail

Two things you will use often are features, not apps:

- **This manual** — the menubar **?**. Read-only, ships with the build.

## Related

- [How Minnow works](../concepts/how-minnow-works.md)
- [Keyboard shortcuts](../reference/keyboard-shortcuts.md)
- [Roadmap](../reference/roadmap.md)
