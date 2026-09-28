# Minnow apps

Minnow Shell (Electron + SPA) is a **workspace-first** stage: menubar, workspace picker, left **app rail**, and full-stage apps in `#osAppsLayer`. Chat lives inside **Code** at `#/app/code/chat`, not on a separate home surface. Default boot hash is `#/workspaces`; legacy `#/desktop` and `#/app/chat` rewrite in [`resolveLegacyHash`](../../src/os/router.ts).

Official product help opens from the menubar **?** button (user manual, not this page). See [Wiki and Brain](../manual/reference/wiki-and-brain.md).

Shell internals: [`src/os/`](../../src/os/). Exhaustive reference: **Minnow Shell** in [`../context.md`](../context.md).

## What ships

**Code** is the primary surface; the rest support work done there. All are **core** (always installed, always on):

| App | Route | Presentation |
|-----|-------|--------------|
| Code | `#/app/code` (+ `overview`, `chat`, `dev-server`) | fullscreen |
| Research | `#/app/research` | fullscreen |
| Models | `#/app/models/<section>` | fullscreen |
| Brain | `#/app/brain/<section>` | fullscreen |
| Issues | `#/app/issues` (+ optional `/<issueId>`) | fullscreen |
| Scheduler | `#/app/scheduler` | side panel overlay (stays over Code) |
| Settings | `#/app/settings` | menubar gear (not on app rail) |

**Settings** opens from the menubar; the left rail lists the other six released apps ([`RAIL_PRIMARY_APP_IDS`](../../src/os/app-preferences.ts)).

No optional app is **released** today, so onboarding **Choose your apps** and **Settings → Apps** show core “Always included” plus **Coming soon**. See [Behind the release gate](#behind-the-release-gate).

## Workspace gate and Code

Cold boot lands on `#/workspaces` until the user picks a folder ([`workspace-gate.ts`](../../src/os/workspace-gate.ts), welcome UI in [`welcome-page.ts`](../../src/ui/welcome-page.ts)). After pick, routing goes to `#/app/code` (overview or chat depending on hash).

**Code** reparents the chat stack into the main column: file tree, CodeMirror, terminal, git, dev servers, browser preview, and the session rail. File and git tools resolve under the open **workspace root**.

The **browser preview** pane (Electron only) renders workspace HTML and localhost URLs in a Chromium guest. **F12** (or **Ctrl+Shift+I** / **Cmd+Opt+I**, or the `</>` toolbar button) toggles DevTools for the previewed page.

## Models

Everything model-related in one place (`#/app/models/<section>`). Nine sections, labels from `SECTION_LABELS` in [`src/ui/models-page.ts`](../../src/ui/models-page.ts):

| Section id | Label | Contents |
|-----------|-------|----------|
| `recommend` | Recommendations | Hardware-aware suggestions (probe via `/api/system/hardware`, fit scoring) |
| `installed` | Installed | Downloaded artifacts under `~/.minnow/models/` |
| `settings` | Library | Hugging Face search/download; **Serve** locally via `llama-server` (auto-registers a provider) |
| `voice` | Voice | Local Whisper (STT) / Qwen3-TTS (TTS) downloads + provider settings |
| `providers` | Providers | Endpoint config; Ollama / LM Studio register existing endpoints when reachable |
| `routing` | Routing | Per-role model routing |
| `sampler` | Sampler | Sampler presets |
| `thinking` | Thinking | Reasoning controls |
| `usage` | Usage & cost | Token usage totals |

The last five are **reparented Settings panels** — `reparentSettingsSectionIntoModels` in [`src/ui/models-sections.ts`](../../src/ui/models-sections.ts) moves the `providers` / `model-routing` / `sampler` / `thinking` / `usage` section nodes out of the Settings page and into Models. They keep their Settings section ids for search and deep links but do not appear in the Settings sidebar.

## Research

Deep, multi-step web research. A sub-agent gathers and synthesizes sources behind a progress stepper. Reports save to a **Library** and can be reopened or discussed. Extracted source text is wrapped in untrusted-data fences before reaching the model.

## Brain

Knowledge surface backed by the **Brain wiki** (CORTEX) at `~/.minnow/brain/`: nested markdown pages with YAML frontmatter, hybrid keyword/vector retrieval, code-symbol indexing, ingest, and lint. Agent tools: `brain_search`, `brain_read_page`, `brain_list`, `brain_write_page`, `brain_append_log`, `brain_ingest_source`, plus code tools `repo_map`, `find_symbol`, `who_calls`, `read_symbol`. `save_memory` writes facts here.

**Sections:** Graph (home), Edit, Log, Schema, Proposals, **Memories**, Ingest, Lint, Code, Settings (embeddings, synthesis cadence, code index). Legacy `#/settings/memory` opens **Memories**.

## Issues

Linear-style issue tracking (`#/app/issues`), fullscreen. List and board views, quick capture, taxonomy in Settings, and `issue_*` agent tools. **Debug** mode routes here (MIN-261). Code can embed the Issues view in the chat column without changing the hash to fullscreen Issues.

## Scheduler

Local recurring agent jobs (`~/.minnow/scheduler.json`) as a full-stage app. Interval (60s minimum) or **cron**, chosen workspace/model, headless `minnow run`. **Jobs only run while Minnow is open** (`npm start` or the packaged shell).

## Settings

Full-page sections at `#/app/settings` (legacy `#/settings/<section>` redirects). Sidebar groups from `SETTINGS_NAV_GROUPS` in [`src/ui/settings-page-types.ts`](../../src/ui/settings-page-types.ts):

| Group | Sections |
|-------|----------|
| **App** | General (leads with App updates), Notifications, Appearance, Audio, About |
| **Apps** | Apps, Issues |
| **Agents** | Agents, Rules, Agent packs, Autopilot, Watchdog |
| **Tools & integrations** | Search, Deep Research, Servers, Tools, Skills, Skills Library, Browser, MCP servers, Language servers, Editor, Webhooks |
| **Advanced** | Health & diagnostics, Board testing |

`SettingsSectionId` also defines `providers`, `usage`, `model-routing`, `sampler`, `thinking`, `prompting`, `modes`, `work-agents`, and `sub-agents`. These are not in every nav group: the first five reparent into **Models**; the rest are reachable via search or direct hash. **Memory** settings live in **Brain**. Search indexes every section and deep-links across apps.

---

## Behind the release gate

Each app has developer `releaseState` (`released` | `hidden`) and `core` / `optional` availability ([`src/os/app-registry.ts`](../../src/os/app-registry.ts)). Hidden apps stay in the tree and tests, but are omitted from onboarding, Settings, the app rail, menubar switcher, shortcuts, notifications, and `launch_minnow_app`. [`parseOsHash`](../../src/os/router.ts) still recognizes `#/app/<appId>` for every registry id; [`applyRoute`](../../src/os/router.ts) blocks developer-hidden apps (redirect to **`#/workspaces`**, no toast) or user-disabled optional apps (toast + redirect).

Currently hidden (MIN-471):

| App | Status |
|-----|--------|
| **Compare** | Blind A/B across 2–6 models, win-rate history under `~/.minnow/compare/`. |
| **Benchmarking** (`bench`) | In-app benchmark battery + run history. |
| **Experts** | Experts' Lab roster of specialist sandbox chats. |

No catalog entries carry an `appId`. Email and Calendar apps were removed (not gated).

**Removed, not gated:** **Reef** mini-app and mode (MIN-473); **Email** and **Calendar** apps.

---

## Operating modes

Modes change system prompt and tool policy ([`src/chat/modes/registry.ts`](../../src/chat/modes/registry.ts)). Four appear in the composer strip:

| Mode | Behavior |
|------|----------|
| **General** | Everyday Q&A; all enabled tools with approval. |
| **Build** | Default development mode; broad tool access. |
| **Plan** | Plan and analyze; destructive file/git tools denied (plan-write guard). |
| **Debug** | Investigate; file/triage via **Issues** and `issue_*` tools. |

Entered elsewhere (not in the strip):

| Mode | Entered from |
|------|--------------|
| **Orchestrate** | Orchestrate hub in Code sidebar / boards. |
| **Super Plan** | Caret under **Plan**, or Orchestrate plan screen. |
| **Onboarding** | First-run wizard only. |

Persisted `'desktop'` and `'email'` remaps to **General** (`normalizeModeId`); they are not live registry entries.

**Reef** mode was removed in MIN-473.
