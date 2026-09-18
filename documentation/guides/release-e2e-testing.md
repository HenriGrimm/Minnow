# Release E2E testing guide

**Maintainers only** — pre-release QA checklist for people shipping Minnow. It is not part of the in-app manual (`minnow_docs_*`) or the end-user wiki path; beta users should follow the [user manual](../manual/).

Manual end-to-end checklist for validating Minnow before a release. Use it after automated CI passes (`npm test`, `npx tsc --noEmit`) and alongside the focused guides linked below.

| Companion doc | When to use it |
|---------------|----------------|
| [Setup](setup.md) | Fresh machine, provider, first run |
| [Apps](apps.md) | What ships vs release-gated |
| [Keyboard shortcuts](keyboard-shortcuts.md) | Shortcut regressions |
| [Orchestrate board testing](orchestrate-board-testing.md) | Kanban / AFK / fake model |
| [Releasing](../maintainer/releasing.md) | Packaged installer + auto-update loop |
| [Troubleshooting](troubleshooting.md) | When a step fails |

---

## Scope

**In scope for a public release** — every user-facing surface that ships with `releaseState: 'released'`, with **Code** carrying the most weight because it carries the most use:

Code, Research, Models, Brain, Issues, Scheduler, Settings — plus composer modes **General**, **Build**, **Plan**, **Debug**, **Super Plan**, and **Orchestrate** (hub). Chat sessions live in **Code** (`#/app/code/chat`).

**Out of scope unless you are flipping a release gate** — Compare, Bench, Experts (hidden per MIN-471). A short appendix lists smoke checks if you enable them locally.

**Not a substitute for automation** — this guide exercises the product the way users do. Keep running `npm test` on Windows and Ubuntu before you sign off.

---

## How to run this guide

### Depth tiers

| Tier | Time (solo) | Goal |
|------|-------------|------|
| **Smoke** | 2–4 hours | Happy paths only; block release if any smoke item fails |
| **Standard** | 1–2 days | All sections through Settings + one Orchestrate board run |
| **Full** | 3–5 days | Standard + edge cases, upgrade path, LAN companion, tool-category sweep |

Work top to bottom once per tier. Within a section, every checkbox is independent unless marked **depends on**.

### Recommended test workspace

Use a real git repo (not the Minnow source tree unless you are dogfooding Minnow itself):

- Small app with `package.json`, tests, and a dev script (Vite or similar)
- At least one failing test you can fix in **Debug** mode
- Enough files for search, LSP, and Brain code index

Keep a second folder with **no git** to verify git-setup prompts and Plan write guards.

### Environment matrix (pick at least two)

| Profile | Why |
|---------|-----|
| **Windows + Electron** (`npm start`) | Primary shipping target |
| **Packaged install** (`npm run package` → run `release/pkg` installer) | SmartScreen, in-process server, auto-update |
| **LM Studio** local server | Default user path |
| **Second provider** (Ollama or cloud API) | Routing and encrypted secrets |

Optional: `MINNOW_BROWSER=1` for one smoke pass (browser-only tools differ; no in-app browser preview).

### Record results

Copy this block into your release notes or Linear issue:

```text
Release E2E — v________  Tester: ________  Date: ________
Build: [ ] dev npm start  [ ] packaged .exe  [ ] upgrade from prior version
Provider: ________________  Model: ________________
Workspace: ________________
Tier: [ ] Smoke  [ ] Standard  [ ] Full
Blockers: 
```

Mark each section **Pass / Fail / Skip (reason)**.

---

## 0. Pre-flight (before opening the UI)

- [ ] `npm ci` && `npm test` && `npx tsc --noEmit` green on your machine
- [ ] Tool server healthy: `curl` with `X-Minnow-Token` from `~/.minnow/session-token` → `/api/tools/ping`, `/api/config/ping`, `/api/memory/ping`, `/api/brain/ping` all `ok`
- [ ] Provider reachable; at least one chat model and (optional) one vision model loaded
- [ ] Electron launches without a blank screen; loader dismisses on `DOMContentLoaded`
- [ ] Terminal shows `Minnow data: <path>` and port (default **9473**)

---

## 1. Clean install and onboarding

**Fresh profile:** use a new Windows user, VM, or rename `%USERPROFILE%\.minnow` temporarily (quit Minnow first).

**Rerun wizard on existing profile:** Settings → General → **Run setup again**.

### Onboarding wizard

- [ ] Welcome → theme applies live on **Appearance** step
- [ ] **Choose your apps** shows core “Always included” + **Coming soon** (no optional toggles in current build)
- [ ] Provider path: local (LM Studio / Ollama) **or** cloud — credentials save; errors are readable
- [ ] Model pick: menubar chip lists models after refresh
- [ ] Extras / permissions / memory steps complete without console errors
- [ ] Finish step opens **Code** (or workspaces picker → Code); chat rail is usable

### First minute after onboarding

- [ ] App rail shows six apps: Code, Research, Models, Brain, Issues, Scheduler (Settings via menubar gear)
- [ ] Menubar: model chip, notifications bell, settings gear
- [ ] Concierge send routes or starts a chat (online routing or offline keyword fallback)
- [ ] Status pill shows Ready (not stuck loading)

---

## 2. Minnow Shell (global chrome)

### Navigation

- [ ] Dock / app rail: open each released app; correct presentation (fullscreen main stage or Scheduler side panel)
- [ ] **Ctrl+Tab** / **Ctrl+Shift+Tab** cycles workspaces picker ↔ recent apps (Windows)
- [ ] Hash routes work: `#/workspaces`, `#/app/code/chat`, `#/app/code`, `#/app/issues`, `#/app/settings/general`
- [ ] Legacy `#/desktop` and `#/app/chat` redirect as expected
- [ ] Legacy `#/settings/<section>` redirects into Settings app
- [ ] Settings opened from Code → **Back** returns to Code (not workspaces picker)
- [ ] Scheduler opens as **side panel** without stealing fullscreen Code focus
- [ ] Deep link `#/app/issues/ISS-n` opens issue detail (after you create an issue in §8)

### Overlays and Scheduler

- [ ] Models, Brain, and other rail apps fill the main stage; back navigation returns to Code as expected
- [ ] Scheduler side panel opens over the current app without losing workspace context
- [ ] **Escape** closes top overlay (tools popover, modals, drawers, Scheduler panel)

### Notifications

- [ ] Bell inbox opens; items clickable where implemented
- [ ] Settings → General → Notifications: sound pack, active-chat sounds
- [ ] Turn-complete / question cues play when expected (not spammy)

### Updates (packaged build only)

- [ ] Settings → General → App updates: version, channel, manual check
- [ ] See [Releasing](../maintainer/releasing.md) for two-version upgrade validation

---

## 3. Code chat

### Sessions

- [ ] New chat from Code session rail; switch chats; titles generate or are editable
- [ ] Chat search popover: find by message text (server FTS when on `npm start`)
- [ ] Multi-select chats (Mod+click, Shift+range); delete with confirm (`appConfirm`, not native `window.confirm`)
- [ ] Workspace picker: change project folder; file tree reloads under new root
- [ ] Restart app: chats restore; lazy history loads when opening a chat (no blank transcript flash)

### Composer

- [ ] **Enter** send, **Shift+Enter** newline
- [ ] Mode picker: General, Build, Plan, Debug
- [ ] **Mod+M** model picker; per-chat model sticks across switches
- [ ] Context usage ring updates during long turns
- [ ] Brain notes toggle and code-map toggle (when Brain enabled)
- [ ] Reasoning / thinking UI matches model capabilities
- [ ] Attach image; attach file; VLM sees image when model supports vision
- [ ] **/** slash picker lists bundled skills + `/compress`, `/goal`, `/loop`
- [ ] Tool approval: **1** / **2** / **3** (once / always / cancel)

### Smart routing

- [ ] Prompt that should open Code (e.g. “edit files in my project”) lands in Code or offers clear handoff
- [ ] Prompt for research opens Research or starts research flow

### Stateful slash commands

- [ ] `/goal <condition>` runs until cleared; `/goal clear` stops
- [ ] `/loop 5m <prompt>` shows loop indicator on sidebar row; pause / skip / stop from loop status UI
- [ ] `/compress` shrinks history; context notice row if policy applies
- [ ] `/clear` clears goal and loops

### Agent activity

- [ ] Footer **agent activity** lists streaming chat / sub-agent / title jobs
- [ ] **Stop all** confirms and halts activity (not scheduler jobs)

---

## 4. Composer modes (policy smoke)

Use the same small task in each mode and verify **tool policy** matches expectations.

| Mode | Prompt idea | Pass criteria |
|------|-------------|---------------|
| **General** | Ask for `get_datetime` + short answer | Tools run; approval respected |
| **Build** | “Create `docs/e2e-probe.md` with one line” | File write succeeds under workspace |
| **Plan** | “Delete `src/main.ts`” | Write denied; plan under `documentation/plans/` allowed |
| **Debug** | “File a bug issue for a fake crash” | `issue_add` or UI issue created |
| **Super Plan** | Start from Plan caret → Super Plan on a small feature | Pipeline stages advance; interview → spec → … without duplicate queued sends |
| **Orchestrate** | See §9 | Board + plan path |

- [ ] `propose_mode_switch` or UI mode change honored when model suggests switch
- [ ] Plan mode: `execute_command` allowed per matrix; mutating git/file tools blocked

---

## 5. Code app

Open **Code**, select test workspace root.

### File tree and editor

- [ ] Tree lists project; filter field works
- [ ] Open file → CodeMirror; save persists to disk
- [ ] **Mod+K** Quick Edit on selection
- [ ] **Mod+I** Intent mode line resolves
- [ ] LSP: diagnostics, **F12** go to definition, rename (**F2**)
- [ ] AI inline ghost + Tab accept; **Mod+→** partial accept
- [ ] Unified tabs: preview HTML/markdown; **F12** DevTools on preview (Electron)
- [ ] File tree context: copy path, delete, **Reveal in system explorer**
- [ ] Drag a file and a folder from the OS into the file tree (imports under the drop folder)
- [ ] After agent `save_file`, tree refreshes without losing scroll/focus

### Terminal

- [ ] **Ctrl+`** toggles panel; PTY tab runs shell
- [ ] New tab; command history **↑** / **↓** (PowerShell or bash per your default shell)
- [ ] Expand terminal maximizes column; restore
- [ ] Reload app: terminal tabs reconnect (PTY survives page reload)

### Git panel

- [ ] Status, stage, commit with AI message button
- [ ] Diff view; pull/push when remote configured
- [ ] **Merge to main** from feature branch (if repo has `main`/`master`)
- [ ] Agent turn with file edits → **Undo turn** / code-change strip when git repo present

### Dev Servers screen

- [ ] `#/app/code/dev-server` opens from sidebar footer
- [ ] Register dev server; start/stop; logs tail
- [ ] Ports list refresh + optional kill
- [ ] Worktree select on server row (if multiple worktrees)

### Code sidebar overlays

- [ ] Code overview / code map toggle from composer
- [ ] Issues overlay from sidebar (embedded list); Back / Escape; does not hijack hash to fullscreen Issues while embedded
- [ ] Orchestrate hub entry from sidebar (if present in your build)

### Browser automation (Electron only)

- [ ] `browser_navigate` + `browser_snapshot` against allowed origin (preview or localhost app)
- [ ] Skill **browser-automation** or Build mode prompt to open preview and screenshot

---

## 6. Tools (representative sweep)

You do not need 111 separate clicks. For each **category**, run one prompt in **Build** with tool permission **Ask** then **Full**, and confirm UI rows + outcomes.

| Category | Example prompt | Server required |
|----------|----------------|-----------------|
| Utility | “What is today’s date?” (`get_datetime`) | No |
| Web | “Search the web for Minnow development workspace” | Yes + search provider configured |
| Files | “Read package.json first 20 lines” | Yes |
| Git | “git status summary” | Yes + git repo |
| Code exec | “Run `npm test` with a 60s cap” | Yes |
| Code intel | “repo_map top of src” | Yes + Brain code index |
| LSP | “List diagnostics for open file” | Yes |
| Memory | “Remember: E2E probe fact” (`save_memory`) | Yes |
| Sub-agent | “Spawn a researcher to summarize README” | Yes |
| Issues | “issue_get_state” | Yes |
| Chat UI | Model uses `ask_question` | No (card UI) |

- [ ] Settings → Tools: Off / Ask / Full persists; composer tools popover matches
- [ ] Web search provider (SearXNG, DDG, Brave, Tavily) selectable; search works
- [ ] Denied tool shows clear error in transcript row
- [ ] MCP: add Context7 or test server; `mcp__*` tools appear when enabled
- [ ] Custom plugin tool in `~/.minnow/tools/` loads (if you ship plugins)

---

## 7. Skills

### Bundled (15)

Smoke one skill from each “family”:

- [ ] `/git-commit` (with staged changes)
- [ ] `/code-review` on a small diff
- [ ] `/ask-user` or ask-user skill triggers question card
- [ ] `/impeccable` — UI critique path (optional UI change)
- [ ] `/caveman` — tone changes; dismiss with stop phrase
- [ ] `/write-tests` on a tiny function

### Skills Library

- [ ] Settings → Integrations → Skills Library: browse offline index
- [ ] Install one skill from a pack (network); appears in `/` picker
- [ ] Remove skill; picker updates
- [ ] Settings → Skills: enable/disable bundled skills

---

## 8. Issues app

- [ ] Quick capture creates issue; appears in list
- [ ] List sort by column headers (session order)
- [ ] Board view: lanes horizontal scroll; drag or status change
- [ ] Multiselect + bulk delete
- [ ] Context menu: open, copy ID, send to chat (mode submenu)
- [ ] Detail: edit description (markdown); labels add/remove
- [ ] Workflow: **Send to chat** starts a chat with the issue seed
- [ ] Settings → Issues: edit taxonomy; delete blocked when referenced
- [ ] Debug mode files issue via agent tool
- [ ] Optional: branch naming `issue/iss-n-*` from workflow docs

---

## 9. Orchestrate

**Fast path (no live LLM):** follow [Orchestrate board testing](../contributor/orchestrate-board-testing.md) — fake model + `POST /api/boards`.

**Release-realistic path:**

- [ ] Plan mode produces `documentation/plans/<name>/` with plan JSON
- [ ] Open Orchestrate hub; `board_init` or UI equivalent creates board
- [ ] Manual mode: start one task; builder chat runs; tester phase if enabled
- [ ] Board header: execution mode, concurrency, model chip, progress telemetry
- [ ] Worktree isolation: file tree follows integration worktree in board view
- [ ] Skip per-task tests option (when enabled) behaves per docs
- [ ] Board log written under `~/.minnow/logs/orchestrate/`; `npm run check:board-log -- <groupId>` passes
- [ ] AFK / auto mode: display sleep does not permanently stall board (resume after unlock)
- [ ] Settings → Advanced → Board testing: scenario runner starts and completes (dev/QA)

---

## 10. Research app

- [ ] New research run; progress stepper advances
- [ ] Cancel mid-run
- [ ] Save to Library; open floating library window
- [ ] Reopen report; **Discuss** seeds chat
- [ ] Source content treated as untrusted in UI (fences in transcript)

---

## 11. Models app

Walk sections at `#/app/models`:

- [ ] **Recommend** — hardware probe returns sensical fit suggestions
- [ ] **Installed** — lists local artifacts
- [ ] **Providers** — add/edit provider; test connection; secrets encrypted (rotate `.key` only on throwaway profile)
- [ ] **Routing** — route model A for chat, B for utility if configured
- [ ] **Sampler** / **Thinking** — change preset; chat honors on next turn
- [ ] **Usage** — token stats accumulate after chats
- [ ] **Voice** — download local STT/TTS or configure provider; mic button in composer if enabled
- [ ] **Download** + **Serve** — optional full download test on fast network

---

## 12. Brain app

Sections at `#/app/brain`:

- [ ] **Graph** — browse wiki tree
- [ ] **Edit** — create page; YAML frontmatter; save
- [ ] **Memories** — CRUD memory entries; toggle store
- [ ] **Ingest** — ingest URL or file snippet
- [ ] **Code** — index workspace; repo map panel loads
- [ ] **Lint** — **Generate plan** (top-bar model set); review plan markdown + summary chips; **Run cleanup** after confirm; execution log completes; Graph reflects changes (or plan-only path if skipping execute)
- [ ] **Proposals** — synthesis proposal queue (if synthesis enabled)
- [ ] **Settings** — embeddings on/off; code index rebuild
- [ ] Chat: `brain_search` + `brain_read_page` in Build mode
- [ ] Memory-saved toast: Reject / Open memory after `save_memory`

---

## 13. Scheduler

- [ ] Open side panel from dock / menubar
- [ ] Create interval job (≥60s) with prompt + workspace + model
- [ ] Job runs while app open; history row appears
- [ ] Pause / delete job
- [ ] Cron expression job (optional)
- [ ] Notification or reminder surfaces when due

---

## 14. Settings (section pass)

Open Settings → use search (**Mod+K**) for spot checks. Visit each sidebar section once.

| Section | What to verify |
|---------|----------------|
| General | Workspace, filesystem access, network LAN toggle, terminal default shell, onboarding rerun, updates |
| Notifications | Sound pack, toggles |
| Appearance | Theme, wallpaper, density |
| Audio | Input/output devices if voice used |
| About | Version string matches build |
| Apps | Core list + Coming soon |
| Issues | Taxonomy tables |
| Agents hub | Links to subsections |
| Rules | Add group + rule; delete empty group; blocked delete of a group that still has rules; enable flag |
| Agent packs | Template download; zip upload (test pack) |
| Autopilot | Board defaults persist |
| Watchdog | Idle / max duration sane defaults |
| Search | Provider + API keys |
| Deep Research | Limits and behavior flags |
| Servers | Dev/proxy entries if used |
| Tools | Global permissions |
| Skills | Enable/disable list |
| Skills Library | Install path |
| Browser | Allowlist origins for automation |
| MCP | Server list |
| LSP | Server status for your language |
| Editor | Intent mode, completion policy |
| Webhooks | Create endpoint; test delivery (SSRF blocked for bad URLs) |
| Health & diagnostics | Viewer opens; optional file errors to Issues |
| Board testing | Scenario list (QA) |

- [ ] Settings search finds “memory” → navigates to Brain Memories
- [ ] No section stuck on “Loading…” forever

---

## 15. Persistence, recovery, and security

- [ ] Kill app during streaming generation; restart → resume or clean error state
- [ ] Kill app with unsent composer text (optional); no session corruption
- [ ] `removeChatById` + immediate flush: chat stays deleted after reload
- [ ] Plan mode cannot write outside `documentation/plans/`
- [ ] Path escape blocked: tool cannot read `C:\Windows\...` outside workspace (default policy)
- [ ] LAN mode off: cannot bind companion without opt-in (default loopback)
- [ ] LAN mode on: pair device flow (see [lan-companion.md](lan-companion.md)) — optional tier

---

## 16. Headless CLI smoke

```bash
npm start   # separate terminal
minnow run --prompt "Reply with exactly: E2E_OK" --start-server
```

- [ ] Exits 0; stdout contains model reply
- [ ] `minnow run --help` documents flags

---

## 17. Automated release gates (run, do not duplicate manually)

| Command | Role |
|---------|------|
| `npm test` | Full unit/integration suite |
| `npm run test:check-coverage` | No orphan test files |
| `npm run test:board` | Orchestrate regressions |
| `npm run board:scenario-contract` | Catalog + adapter contract (PR + release workflow) |
| `npm run package` | Production build succeeds |

---

## 18. Sign-off

- [ ] All **Smoke** items Pass on Windows packaged build
- [ ] No P0/P1 bugs open for the milestone
- [ ] Release notes drafted for GitHub (user-facing)
- [ ] `version` bumped in `package.json` per [Releasing](../maintainer/releasing.md)
- [ ] Optional: second tester cross-checks §4 modes + §9 Orchestrate

**Signed:** __________________ **Date:** __________________

---

## Appendix A — Release-gated apps (hidden)

Only when `releaseState` is flipped to `released` in `src/os/app-registry.ts`:

| App | Minimal smoke |
|-----|----------------|
| Compare | Start blind compare; vote; reveal |
| Bench | Run one benchmark battery |
| Experts | Open Experts' Lab; one expert chat |

---

## Appendix B — Reset helpers (QA)

| Goal | Action |
|------|--------|
| Rerun onboarding | Settings → General → Run setup again |
| Fresh `~/.minnow` | Quit Minnow; rename/delete profile folder |
| Reset sessions only | Backup then remove `sessions/sessions.db` (destructive) |
| Orchestrate test board | `POST /api/boards` ([board testing guide](../contributor/orchestrate-board-testing.md)) |

---

## Appendix C — Suggested smoke script (90 minutes)

1. Pre-flight §0  
2. Onboarding §1 (or rerun wizard)  
3. Code chat send + tool approval §3  
4. Code: open file, terminal, git status §5  
5. Plan vs Build write guard §4  
6. One Issues capture §8  
7. Research quick run §10  
8. Models provider ping §11  
9. Brain edit + search §12  
10. Scheduler 60s job §13  
11. Settings search + General updates §14  
12. `npm test` §17  

This script does **not** replace Standard tier before a major release.
