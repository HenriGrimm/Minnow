# Code

Code is the development environment: a file tree, an editor with AI completion and language-server intelligence, terminals, git, dev servers, and a browser preview — with chat sitting beside all of it, working on the same folder you are.

Open it from the **app rail** (or land here after the workspaces picker). It takes the full screen.

## Open a project

Code opens on a welcome screen with **Open project**, **Create project**, and your recent workspaces.

The folder you pick becomes the **workspace root**, and that is the boundary for file, git and search tools. An agent asking for a path outside it gets refused. That is the point — see [Tools and permissions](../concepts/tools-and-permissions.md).

## The layout

- **Left:** chat sidebar — sessions, groups, board folders, search, and a footer rail of tools.
- **Middle:** chat, with the composer at the bottom and the inference metrics strip beneath it.
- **Right:** file tree, editor tabs, and preview.
- **Bottom:** the terminal panel when you open it.

The footer rail of the sidebar is where the less obvious surfaces live:

| Button | Opens |
|--------|-------|
| **Issues** | The issue tracker embedded in the Code window |
| **Inference metrics** | Token counts, tok/s, totals |
| **Agent activity** | What sub-agents are doing right now |
| **Terminal** | The terminal panel (**Ctrl+`**) |
| **Code map** | Indexed symbols and call relationships for the repository |
| **Dev servers** | The dev-server screen |
| **Orchestrate boards** | The board hub |

Collapse the sidebar to a 48-pixel icon rail when you want the room.

## The editor

CodeMirror with syntax highlighting, plus two AI editing modes and real language-server support.

| Keys | Action |
|------|--------|
| **Ctrl/Cmd+K** | Quick Edit on the selection — describe a change, get a diff |
| **Ctrl/Cmd+I** | Toggle Intent mode |
| **Ctrl/Cmd+Enter** | Force an intent proposal for the current line |
| **Tab** | Accept an intent proposal, AI ghost text, or an open completion; otherwise indent |
| **Ctrl/Cmd+→** | Accept the next word of ghost text |
| **Ctrl+Space** | Trigger a completion |
| **F12** or **Ctrl/Cmd+click** | Go to definition |
| **Ctrl/Cmd+S** | Save |
| **Ctrl/Cmd+W** | Close the tab |
| **Ctrl/Cmd+Tab** | Cycle tabs |
| **Ctrl/Cmd+F** | Find and replace |
| **Escape** | Dismiss a proposal or ghost text, or blur the editor so Tab navigates the app again |

**Quick Edit** is a surgical change to a selection. **Intent mode** is different: you write what a line should do (English, pseudocode, or even broken code) and pause — a proposal appears below the line. **Tab** accepts it and the text becomes ordinary code; **Esc** dismisses it; **Ctrl+Z** undoes an accepted proposal like any other edit. Nothing is written to your file until you press Tab.

Intent auto-triggers on lines that read as plain English (and on comment lines holding plain English) in files Minnow recognises as source code. If the detection gets in your way, set a **trigger prefix** in Settings — then only lines starting with it are treated as intent. **Ctrl/Cmd+Enter** always forces a proposal, whatever the line looks like.

Intent shares the editor AI model with inline completion and Quick Edit by default, and can be pinned to its own provider and model. Configure it in **Settings → Integrations → Editor**, which also controls ghost-text behaviour, how much import and language-server context goes into completions, and caching.

Language-server diagnostics, hover and signature help work where a server is installed — TypeScript and JavaScript are bundled. See [Integrations](../extend/integrations.md).

Files get the same colourful icons as VS Code, in the tree and on tabs.

## The file tree

Full file operations, keyboard-driven when the tree has focus:

| Keys | Action |
|------|--------|
| **Enter** / **Space** | Open a file, or expand a folder |
| **F2** | Rename |
| **Ctrl/Cmd+C / X / V** | Copy, cut, paste within the workspace |
| **Delete** | Delete |

Right-click for the context menu, including **Open in System Explorer** and **Copy path** (workspace-relative path on the system clipboard).

Drag a file or folder from Explorer or Finder into the tree to copy it into the project — onto a folder to import there, or onto empty space for the workspace root. Drag a file into the composer to attach it as a workspace reference the model can read with tools. Drag a file or folder into the terminal to insert its path at the shell prompt.

When an agent writes files, the tree patches only the affected folders instead of rebuilding. Your scroll position, keyboard focus and expanded folders survive.

## Terminal

**Ctrl+`** toggles the panel. Tabs are the **Agent** tab, which shows the output of commands the model ran, plus any interactive PTY sessions you open.

- **↑ / ↓** recalls that tab's command history, kept per tab across reloads.
- **Ctrl/Cmd+C** copies the selection, or sends SIGINT when nothing is selected.
- **Ctrl+V** (Windows/Linux) and **Cmd+V** (macOS) paste clipboard text at the prompt.
- **Expand** fills the chat column with the terminal; press it again to dock.
- Sessions survive a reload — Minnow reconnects and replays scrollback rather than killing your shell.

On Windows, **Git Bash** appears when Git for Windows is installed, and installed WSL distributions appear as their own shell options. Pick one under **Settings → General → Chat & terminal → Default shell** (or override per workspace) and both terminal sessions and agent commands run inside it. WSL maps Windows paths to `/mnt/...`. Git Bash keeps a Windows working directory and does not use the WSL Landlock sandbox.

## Git

The source-control panel does status, stage, diff, commit, branch, pull and push. If the folder is not a git repository yet, **Set up git** starts a background chat that initializes it (init, `.gitignore`, first commit) without leaving the panel.

Commit, push, pull, merge, and other git or GitHub actions show a small bouncing progress bar while they run. Success is a short confirmation. Failures open a popover with a plain-language title, a short summary, the raw details, and **Send to chat** so an agent can fix the problem.

- **Commit messages** can be generated from the staged diff: conventional commits with optional gitmoji, an imperative subject, and a body explaining why. The `/git-commit` skill uses the same conventions. History shows gitmoji as emoji even when a commit stored a colon code such as `:sparkles:`.
- **Commit and file diffs** open as a side-by-side review in the workspace. Long lines **wrap by default**; use the **Wrap** control in the review header to turn wrapping off when you want a single-line scroll.
- **Merge to main** appears when you are on a feature branch: it checks out the trunk in the main workspace, merges your branch, and switches you back — warning you first if the tree is dirty and surfacing merge failures in a popover with an option to send them to chat.
- Names you type when creating a **branch** or **worktree** (composer, Source Control, or the git panel) are turned into a git-safe slug: `Test Worktree` becomes `test-worktree`. Empty or illegal characters are stripped; the dialog shows the name that will be used. The same dialog lets you pick which existing branch to start from (local or remote-tracking). For a worktree you can **Check out** an existing branch instead of creating a new one.
- Agents use the same git operations through tools, so you and the model are never looking at different states.

## Source Control Center

The sidebar panel covers the everyday loop. For the full surface — **Changes**, **History**, **Branches**, **Stashes**, **Worktrees**, **Pull requests**, and **Checks** — open the **Source Control Center** from the navigation rail or that panel. It opens as its own app, keeping your chat intact. **Ctrl+1**–**7** jump between sections; **Ctrl+K** opens the **Commands** palette (rebase, cherry-pick, stash, worktree, open PR, review the current branch PR, and similar). Pull requests and CI use your local `gh` CLI (Minnow stores no GitHub token). Open pull requests can be reviewed in-app with **Review PR**; the review stays in Minnow and is not posted to GitHub. Screenshots and a longer walkthrough: [Source Control Center in the project README](https://github.com/HenriGrimm/Minnow#source-control-center--the-full-git-surface).

## Dev servers

A first-class screen rather than a terminal tab you have to remember. Register the servers a project needs — command, working directory, port, auto-start, and which git worktree to run in — then start, stop and restart them from one place, with logs and a listening-ports view.

Minnow wires the **Port** field by stack: Vite gets `--port`, Next gets `-p`, and stacks that reject those flags (including electron-vite) get `PORT` / `VITE_PORT` in the environment instead. Configs that ignore env keep their own port. Split stacks (API + client via `concurrently`) inject the port into the client, set `PORT` for the API, and health-check the UI.

The `manage_dev_servers` tool gives the model the same controls, so "start the dev server and check the console" is one instruction.

## Browser preview

A real Chromium view for workspace HTML and localhost URLs. Navigate, reload, and toggle **DevTools** with **F12** or **Ctrl/Cmd+Shift+I** — console, network and element inspection for the previewed page.

The preview is the user surface for `browser_*` tools when an agent deliberately passes `surface: "user"` and an explicit `tab_id`. It is useful when you want the agent to work in a visible preview tab. Navigation is restricted to an allowlist that starts at localhost only; see [Integrations](../extend/integrations.md).

For isolated work, the agent can use **Agent Browser**. It reserves a private headless tab, then passes the returned `tab_id` to every later browser call. Open the Agent Browser viewer from the browser sidebar button to watch a tab, select **Guide** to send a page-element note to its owner, or choose **Take control** for deliberate user input. Closing the viewer leaves browser work running, and screenshots still work while it is closed.

## Working with the assistant here

The normal shape of a Code session:

1. Open the project. Set the composer to **Build**.
2. Ask for the change. The model reads files, proposes edits, runs tests.
3. Approve tools as they come up, or move the ones you trust to Full.
4. Check the diff in the git panel before committing.

Two habits that pay off: **commit before a long agent run**, and use **Plan** mode first when the change is big enough that you want to agree on the approach before any file is touched.

If a turn goes wrong, the undo control beside the changes strip rewinds the turn and restores the working tree from a git snapshot. See [Working in chat](../chat/chatting.md).

## Related

- [Modes](../concepts/modes.md)
- [Orchestrate boards](../orchestrate/boards.md) — parallel delivery from a plan
- [Keyboard shortcuts](../reference/keyboard-shortcuts.md)
- [Troubleshooting](../reference/troubleshooting.md)
