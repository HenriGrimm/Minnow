# Architecture overview

A high-level map of how Minnow fits together. For the exhaustive, file-by-file reference, read [`../context.md`](../context.md) — this guide is the orientation layer above it. To run from source: [setup-from-source.md](setup-from-source.md).

## Three processes

```
┌─────────────────────────────────────────────────────────────┐
│ Electron desktop shell  (electron/)                          │
│  • BrowserWindow hosts the SPA                               │
│  • WebContentsView preview = the in-app browser (browser_*)  │
│  • In electron:prod, hosts the built SPA via Connect + sirv  │
└───────────────┬─────────────────────────────────────────────┘
                │ loads
┌───────────────▼─────────────────────────────────────────────┐
│ SPA  (src/, index.html — Vite + TypeScript, no framework)    │
│  • Minnow Shell (src/os/): workspace gate, app rail, menubar, app host   │
│  • Chat + modes + prompts (src/chat/)                        │
│  • Agent layer: tools, sub-agents, work agents (src/agents,  │
│    src/tools)                                                 │
│  • Per-app modules: models, compare, research,               │
│    scheduler, voice, memory, benchmark, …                    │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP/SSE to same origin
┌───────────────▼─────────────────────────────────────────────┐
│ Node tool server  (server.js + server/)                      │
│  • Serves the SPA via Vite (dev) and proxies providers       │
│  • Tools: files, git, code, shell/PTY, web, LSP, MCP, …      │
│  • Generations: buffered, resumable SSE streams              │
│  • Apps' backends + persistence under ~/.minnow              │
└─────────────────────────────────────────────────────────────┘
```

- **`npm start`** (`server.js`) runs all three: Vite + tool server, then launches Electron.
- **`npm run dev`** runs only the SPA via Vite — the tool server and most features are absent.
- **`npm run electron:dev`** / **`npm run desktop`** run `server.js` with `MINNOW_ELECTRON=1` plus the Electron dev launcher (HMR-friendly alias of the full stack).

## The SPA (`src/`)

No UI framework — direct TypeScript + DOM with CSS tokens. Boot order in [`src/main.ts`](../../src/main.ts): page bridge → OS shell → router. Key areas:

- **`src/os/`** — workspace-first shell: stage, app rail, menubar, router, workspace gate, app registry; released apps mount as full-stage layers in `#osAppsLayer`. Scheduler mounts in the same foreground stage; its job editor opens as an overlay within that app.
- **`src/chat/`** — chat orchestration, composer **modes** (`modes/registry.ts`; four in the composer strip), prompt composition (`prompts/`).
- **`src/tools/`** — the tool catalog ([`definitions.ts`](../../src/tools/definitions.ts); counts and release states in the [generated inventory](architecture-inventory.md)), executors, and permission gating. Product chat send is [`runChatTurn`](../../src/chat/run-turn-chat.ts) around [`runTurn()`](../../server/runner/run-turn.js) — not a client copy of the stream/tool loop.
- **`src/agents/`** — sub-agent runner/controller, work agents, sampler resolution, UI Designer.
- **`src/api/`** — provider/model fetching, SSE parsing (`sse-parse.ts`), generations client.
- **Feature modules** — `models/`, `research/`, `scheduler/`, `voice/`, `memory/`, `notifications/`, `webhooks/`, `oauth/`, `lsp/`, `mcp/`, `skills/`, plus `compare/` and `benchmark/` for release-gated apps.
- **`src/ui/`, `src/styles/`, `src/markdown/`, `src/theme.ts`** — views, `--mn-*` CSS tokens (see [`DESIGN.md`](../../DESIGN.md)), markdown rendering, theming.

## The tool server (`server/`)

A Connect-style Node app. `server.js` wires Vite middleware in dev and the API routers; `server/runtime/` bootstraps stores and registers middlewares. Each subsystem has its own folder: `tools/`, `generations/`, `providers/`, `config/`, `memory/`, `brain/`, `engine/`, `models/`, `compare/`, `research/`, `scheduler/`, `voice/`, `stt/`, `tts/`, `mcp/`, `lsp/`, `terminal/`, `webhooks/`, `oauth/`, `security/`, `agents/`, `work-agents/`, `profiles/`, `prompts/`, `skills/`, `system/`.

### Generations (streaming)

Chat completions are **backend-owned**: the client POSTs to `/api/generations`, then reads a resumable SSE stream (`/api/generations/:id/stream`) that replays buffered tokens and continues live — so a reload re-attaches instead of losing the turn. Parsing lives in [`src/api/sse-parse.ts`](../../src/api/sse-parse.ts).

### Tools

Tools are either **browser-native** (run in the page — utilities, sub-agent/board, mode handoff, `browser_*`) or **server-required** (proxied to `POST /api/tools`). Permissions are per-tool (`full` / `ask` / `off`) with an in-chat approval modal. File/git tools are sandboxed to the workspace root unless `TOOLS_ALLOW_ALL_PATHS=1`. **Plan mode** additionally denies destructive tools.

## Agent layer

- **Sub-agents** — `spawn_sub_agent` runs nested agent loops with concurrency caps, per-type model/sampler bindings, budgets + structured summaries, and persisted runs surfaced as live cards.
- **Work agents** — composer-selectable agents with their own provider/model.
- **Skills** — `SKILL.md` packs (built-in + user) invoked via `/` slash commands.
- **Prompts** — full / lite / custom profiles, prompt diffing vs. shipped defaults, and portable bundles under `~/.minnow/profiles/`.

## Security model

- **Encrypted secrets** — AES-256-GCM envelopes (`server/security/secret-box.js`) with a file key at `~/.minnow/.key`; provider/account secrets migrate from plaintext on first read.
- **Prompt-injection defense** — untrusted text (memory, web/RAG, research extraction, documents, email) is fenced with `<<<UNTRUSTED_SOURCE_DATA …>>>` markers (`src/lib/untrusted.mjs` / `server/security/untrusted.js`).
- **SSRF guards** — webhook and CalDAV targets resolve DNS and block private/link-local addresses.
- **Browser allowlist** — `browser_*` navigation is restricted by origin patterns.

## Persistence

All durable state lives under `~/.minnow` (override with `MINNOW_HOME`). See [`../manual/reference/configuration.md`](../manual/reference/configuration.md) for the layout. Sessions live in `sessions/sessions.db` (SQLite via [`server/config/sessions-repo.js`](../../server/config/sessions-repo.js)): SPA boot loads summaries and hydrates chat history on demand; PATCH flushes dirty chats/groups; FTS5 backs `/api/config/sessions/search`. Markdown stores (Brain wiki, memory) keep frontmatter files as the source of truth with rebuildable caches.

## Where to dig deeper

| Topic | Reference |
|-------|-----------|
| Full architecture, every API and store | [`../context.md`](../context.md) |
| Visual design & theme tokens | [`../../DESIGN.md`](../../DESIGN.md) |
| Build plans & roadmaps | [`../plans/`](../plans/) |
| Tool plugin authoring | [`../plugins/tool-authoring.md`](../plugins/tool-authoring.md) |
| Contributor index | [README.md](README.md) |
