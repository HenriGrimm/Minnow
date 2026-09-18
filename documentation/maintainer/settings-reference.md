# Settings reference

Complete inventory of Minnow settings: where they appear in the UI, what they control, and where they are persisted.

For storage layout and `config.json` overview, see [Where your data lives](../manual/reference/configuration.md). For the Settings page IA and search catalog, see [`src/ui/settings-catalog.ts`](../../src/ui/settings-catalog.ts).

**Last updated:** 2026-08-03

---

## Summary counts

| Item | Count |
|------|------:|
| Settings sidebar categories | 6 |
| Settings sections (areas) | 33 |
| Cataloged searchable fields | ~100 |
| Built-in tools (catalog) | 114 |
| Built-in tools shown in a default build | 106 |
| Composer modes | 4 |
| Built-in experts | 6 |
| Built-in work agents | 7 |
| Built-in sub-agent types | 8 |
| Theme families | 4 |

---

## Settings app structure

Open via **Settings** (`#/settings/<category>`) or legacy `#/settings/<area>`.

| Category | Sections |
|----------|----------|
| **General** | General, Notifications, Audio, About |
| **Apps** | Apps |
| **Appearance** | Appearance |
| **Agents** | Prompts, Rules, Modes, Work agents, Agent packs, Sub-agents, Autopilot, Watchdog |
| **Integrations** | Search, Deep Research, Servers, Tools, Skills, Browser, MCP, LSP, Editor, Webhooks, OAuth |
| **Advanced** | Health & diagnostics |

**Integrations hubs** (10 sub-tabs): Search · Deep Research · Servers · Tools · Skills · Browser · MCP servers · Language servers · Editor · External.

Model configuration lives in the **Models app**: Providers, Routing, Sampler, Thinking, Usage & cost, and Voice. Legacy `#/settings/<model-area>` links redirect there. Device routing remains under **Settings → Audio**.

---

## 1. General

### General → General

| Setting | Persistence | Notes |
|---------|-------------|-------|
| App updates | Electron main (`~/.minnow/updater.json`) | Channel, check now, restart to install |
| Desktop app → Keep running after close | `config.desktopShell.closeToTray` | Default **on**; Electron tray lifecycle |
| Desktop app → Interface zoom | `config.desktopShell.zoomPercent` | Default **80**; Electron main applies on load; Ctrl/Cmd +/− syncs to config |
| Desktop app → Launch at startup | OS login item (`app.setLoginItemSettings`) | Windows/macOS only; not stored in config.json |
| Filesystem access | `config.toolSecurity.filesystemAccess` | `workspace` (project folder only) vs `full` (entire disk). Override: `TOOLS_ALLOW_ALL_PATHS=1` |
| Network access | `config.server.networkAccess` | `local` (loopback) vs `lan` (Wi‑Fi). Override: `MINNOW_NETWORK` |
| Terminal behavior | — | Info only: commands run in background |
| Constrained tool calls | `config.toolCalls.useConstrainedDecoding` | JSON Schema on tool turns |

### General → Notifications

| Setting | Persistence | Notes |
|---------|-------------|-------|
| Enable notifications | `localStorage` (`notification prefs`) | Master bell toggle |
| Silence notifications (dropdown) | `minnow.notifications.muted` | Quick mute from menubar bell popover; blocks new alerts until cleared |
| Chat notifications | notification prefs | Background chat finish/error |
| Task & sub-agent notifications | notification prefs | Orchestrate board + sub-agent events |
| Background job notifications | notification prefs | Scheduler, research, memory/skill proposals |
| Play notification sound | notification prefs | When Minnow is unfocused (Electron: includes alt-tab / minimized) |
| Sounds in active chat | `minnow.notifications.soundOnActiveChat` | Play cues while watching the chat in Code (no bell alerts) |
| Sound pack | `minnow.notifications.soundPackId` | `default` (Minnow cues) or `none` |

### General → Audio

| Setting | Persistence |
|---------|-------------|
| Input device | `config.voice.audio.inputDeviceId` |
| Output device | `config.voice.audio.outputDeviceId` |
| Echo cancellation | `config.voice.audio.echoCancellation` |
| Noise suppression | `config.voice.audio.noiseSuppression` |
| Auto gain control | `config.voice.audio.autoGainControl` |

---

## 2. Apps

Choose which Minnow apps appear in the dock, menubar shortcuts, notifications, and agent `launch_minnow_app` choices. Changes apply immediately (no restart).

| Setting | Persistence | Notes |
|---------|-------------|-------|
| App visibility | `localStorage` `minnow.os.disabledApps` | JSON array of disabled **optional** app ids. Missing key = all released optional apps enabled |
| Always included | — | One-line note: Chat, Models, Brain, Settings (cannot be disabled) |
| Optional apps | same key | Quiet toggle cards + Enable all / Disable all. Off apps stay visible and dimmed |

**Behavior**

- New users and installs with no stored preference start with every released optional app selected.
- Disabling an optional app removes it from launch surfaces and closes any running instance of that app.
- Developer-hidden apps (`releaseState: 'hidden'` in [`src/os/app-registry.ts`](../../src/os/app-registry.ts)) are omitted from this page and from all launch paths.
- Blocked deep links for user-disabled apps return to the desktop and point users here to restore the app.
- Shared UI with onboarding: [`src/os/app-picker-ui.ts`](../../src/os/app-picker-ui.ts).

Search keys: `apps.visibility`, `apps.core.<id>` (on the core note names), `apps.optional.<id>`.

---

## 3. Appearance

Stored primarily in browser `localStorage` (custom token overrides may sync via appearance modules).

**Agent writes (Desktop mode only):** use `get_appearance`, `update_appearance`, and `upload_appearance_asset` — not `update_settings`. Registry keys `appearance.theme.family`, `appearance.theme.mode`, and `appearance.wallpaper` remain readable via `get_settings` but are not writable through the settings agent tools.

| Setting | Options / notes |
|---------|-----------------|
| Theme family | `sage`, `amber`, `cyan`, `coral` |
| Theme mode | `dark`, `light` per family |
| Follow system | Match OS dark/light |
| Desktop wallpaper | Minnow wallpaper image |
| Fonts | UI + mono presets from a Google Fonts catalog (lazy-loaded) plus uploads |
| Custom colors | Per-token `--mn-*` overrides |

---

## 4. Models

### Providers (`~/.minnow/providers/<id>/`)

| Field | Notes |
|-------|-------|
| ID | Slug (e.g. `lm-studio-local`) |
| Label | Display name |
| Base URL | OpenAI-compatible endpoint |
| API kind | API flavor |
| Auth style | Key placement |
| Models path | e.g. `/v1/models` |
| Chat completions path | e.g. `/v1/chat/completions` |
| API key | Encrypted in `secrets.json` |
| Enabled | On/off |
| Capability probes | Tool calling, constrained decoding (cached) |
| Pricing (optional) | `inputPer1M` / `outputPer1M` for Usage stats |

Also: `config.activeProviderId`.

#### One-click provider presets

Catalog: [`src/providers/presets.ts`](../../src/providers/presets.ts). Presets appear as chips in **onboarding → Cloud API** (a green check on a chip means that preset already has a saved API key) and as a preset grid in **Models → Providers → Add provider** (choose a preset or **Add custom provider** for the full form).

| Preset | Base URL | API kind | Auth | Notes |
|--------|----------|----------|------|-------|
| OpenCode Go | `https://opencode.ai/zen/go` | OpenAI v1 | Bearer | Gateway auto-API; Minnow User-Agent + `x-opencode-session` (chat id). Muse Spark 1.2/1.3, GPT 5.6 Luna, and Grok 4.6 POST `/v1/responses`; most other Go models stay `/v1/chat/completions`; Claude-looking ids use `/v1/messages`. |
| OpenCode Zen | `https://opencode.ai/zen` | OpenAI v1 | Bearer | Gateway auto-API |
| Anthropic | `https://api.anthropic.com` | Anthropic Messages | X-Api-Key | |
| DeepSeek | `https://api.deepseek.com` | OpenAI v1 | Bearer | |
| GitHub Copilot | `https://api.githubcopilot.com` | OpenAI v1 | Bearer | Gateway auto-API; OAuth Bearer token |

Also available: OpenRouter, OpenAI, Groq, Mistral (same catalog).

**GitHub Copilot account variants:** edit the base URL after applying the preset — Business: `https://api.business.githubcopilot.com`, Enterprise: `https://api.enterprise.githubcopilot.com`.

**Env overrides:** there are no dedicated environment variables for preset base URLs. Provider profiles are stored under `~/.minnow/providers/<id>/` (override data dir with `MINNOW_HOME`). Network bind mode uses `MINNOW_NETWORK` (`local` / `lan`).

### Routing

Per routing row: **provider**, **model**, **sampler override**, **thinking mode**, **fallback chain**.

| Row | Persisted in |
|-----|--------------|
| Main chat | Session + global sampler |
| Work agents (see below) | `work-agents.json` |
| Sub-agent types (see below) | `sub-agents.json` |
| UI Designer (skill/runtime) | `config.uiDesigner` |
| Chat title jobs | `config.titles` |
| Goal evaluator | `config.goalEval` |

**Global fallback** (`config.fallbackChains`):

| Field | Default |
|-------|---------|
| `enabled` | `false` |
| `cooldownSeconds` | `60` |
| `maxChainLength` | `4` |
| Per-role chains | `_global`, `default`, `utility`, `research`, `vision` |

### Sampler (`config.sampler`)

Temperature · Top P · Top K · Min P · Repeat penalty · Presence penalty · Max tokens

### Thinking (`config.thinking`)

| Field | Options |
|-------|---------|
| Global default | `on` / `off` |

Per-role overrides in Routing.

### Usage & cost

Read-only token/inference usage (`#/settings/usage`). Distinct from prompt token **estimate** in the settings header.

### Models app → Voice (`config.voice`)

**STT:** backend (`local` / `provider`), streaming dictation, model, language, task, device, compute type, chunk/batch/beam settings, provider API fields, limits (`maxAudioBytes`, `maxDurationSeconds`, `silenceTimeoutSeconds`).

**TTS:** local Qwen or provider API; model, device, dtype, voice clone prompts, speed, format.

See [`src/config/voice-meta.ts`](../../src/config/voice-meta.ts) and [`src/voice/settings-form.ts`](../../src/voice/settings-form.ts).

---

## 5. Agents

### Prompts

| Setting | Persistence |
|---------|-------------|
| Prompt profile | `activePromptProfile` (`full` / `lite` / `custom`) |
| Setup profiles | `profiles/` bundles |
| Custom prompt configs | Per-part editors (base, mode, expert, info, tool-usage, work-agent, memory, skills) |
| System prompt | Shared prompt parts appear first on the Agents page |
| Role prompts | Composer mode and work-agent cards open their prompt editors |

### Rules (`rules.json`)

| Setting | Description |
|---------|-------------|
| Enable user rules | Master toggle for all standing instructions |
| Rule groups | Named sections (e.g. General, Git, Style) |
| Rules | Per-rule title, instructions, enabled flag, and group assignment |

Settings UI: **Agents → Rules** — grouped list with per-rule enable switches; add/edit via anchored popover; **Delete group** on extra empty groups ([`src/ui/settings-rules.ts`](../../src/ui/settings-rules.ts), [`src/ui/settings-rules-popover.ts`](../../src/ui/settings-rules-popover.ts), [`removeUserRuleGroup`](../../src/config/user-rules.ts)). A group that still has rules cannot be deleted (message includes the count) so rules are never dropped or remapped. Enabled rules compose into a second system message on parent chat send ([`src/config/user-rules.ts`](../../src/config/user-rules.ts)). Legacy v1 `{ text }` blobs migrate automatically.

### Modes (7 live + persist remaps)

Composer strip: `general` · `build` · `plan` · `debug`

Entered elsewhere: `orchestrate` (hub) · `super-plan` (Plan sub-menu) · `onboarding` (first run). Persisted `desktop` and `email` remap to `general`. `reef` was removed in MIN-473.

Only the four composer modes are listed on the Agents settings page. Internal first-run and board-entry modes remain runtime concerns.

| Per-mode | Notes |
|----------|-------|
| Tool policy | Default allow/deny (prompt editor opens from the mode card) |
| Plan granularity | `large` / `medium` / `small` — `config.planning.granularity` |
| Super Plan pipeline | Settings → Agents → Super Plan mode (lightbox) — `config.planning.superPlan` |

#### Super Plan (`config.planning.superPlan`)

| Setting | Default | Description |
|---------|---------|-------------|
| Review rounds | `2` | Draft/review cycles before Impeccable |
| Grill question budget | `20` | Target clarifying questions in grill stage |
| Impeccable | `auto` | `auto` (when UI detected) / `always` / `never` |
| Research scope | `both` | `web` / `codebase` / `both` for Deep Research stage |
| Research rounds | `0` (auto) | Explicit cap; `0` uses depth preset or engine auto |
| Research depth | `auto` | When rounds auto: `quick` (2) / `standard` (3) / `deep` (5) / engine default (8) |
| Research model | chat default | Optional provider/model override for research stage |
| Reviewer model | sub-agent default | Optional override for `plan-reviewer` sub-agent |
| Planner model | chat default | Optional override for draft/finalize chat turns |

Persistence: `config.json` → `planning.superPlan`; client mirror in `localStorage` key `minnow.superPlanMeta`. Loader: [`src/config/super-plan-meta.ts`](../../src/config/super-plan-meta.ts).

### Experts (6 built-in)

`general` · `software-engineer` · `data-analyst` · `creative-writer` · `security-reviewer` · `technical-writer`

Prompt overrides remain under `~/.minnow/prompts/experts/`. User-created experts are supported by the retained implementation, but the **Experts** desktop app (Expert Lab) is release-gated off and experts are not listed on the Agents settings page in this build.

### Work agents (7 built-in)

`general` · `builder` · `planner` · `reviewer` · `researcher` · `ui-designer` · `tester`

Per agent: **enabled**, **max input tokens**, **context policy** (`compact` / `slide` / `truncate`), compaction config, model binding, and prompt override. Open a work-agent card on the Agents page to edit it.

### Agent packs

Drop-in work agent bundles under `~/.minnow/agent-packs/<pack-id>/` (`manifest.json` + `prompts/`). Settings → **Agent packs** lists installed packs, validates manifests, toggles enablement (`PATCH /api/agent-packs/:id`), and offers **Download template** (`GET /api/agent-packs/template`), **Download default pack** (`GET /api/agent-packs/builtin` → `minnow-default-agent-pack.zip` with shipped work agents), and **Upload pack** (`POST /api/agent-packs/upload`, multipart `.zip`). On first `npm start`, `~/.minnow/agent-packs/_template/` is also created for local copying. Enabled pack agents merge into work agents as `packId.agentKey`. Authoring: [`documentation/agent-packs/README.md`](../agent-packs/README.md).

### Sub-agents

**Global** (`sub-agents.json`):

| Setting | Description |
|---------|-------------|
| Enabled | Master toggle |
| Max concurrent | Global cap |
| Default timeout | ms; a caller-supplied `timeoutMs` on the spawn wins over this and over the per-type value |
| Check-in nudge | ms (0 = off) |

Stall, heartbeat, and loop detection are **not** here — see [Watchdog](#watchdog-configjson--chat-sub-agentsjson).

**Types (11):** `generalPurpose`, `explore`, `researcher`, `shell`, `explorer`, `debugger`, `bug-planner`, `issue-writer`, `plan-reviewer`, `pr-reviewer`, `plan-repairer`

Per type: enabled, max concurrent, timeout, max input tokens, context policy, summary schema, allowed/denied tools, sampler, thinking, provider/model.

### Autopilot (`config.autopilot`)

| Group | Settings |
|-------|----------|
| Board defaults | Execution mode (`manual`/`sequential`/`auto`/`afk`), isolation (`auto`/`off`/`per-task`/`per-wave`), max concurrent tasks |
| Test & build retries | Per-task test/build attempts, final test attempts, continue smart-route (`off`/`conservative`/`aggressive`) |
| Heartbeat & stall | Removed in P8-G. Leftover `autopilot.heartbeatIntervalMs` / `progressStallMs` / `heartbeatDeadMs` keys are stripped on save and are not read |
| Planner model fallback | Provider + model |
| Self-heal & provisioning | Max self-heal rounds, infra provision timeout, auto-provision infra, auto-restart stalled tasks, guard `cd` outside worktree |

`selfHealMaxRounds` doubles as the watchdog recovery-attempt cap: it bounds total dispatches per logical task across the tier-1/tier-2 restart chain.

### Watchdog (`config.json` → `chat`, `sub-agents.json`)

Settings → **Agents → Watchdog**.

**Generation timeouts** — server-side limits while streaming from the model:

| Setting | Key | Default |
|---------|-----|---------|
| Idle timeout (minutes) | `chat.generationIdleTimeoutMs` | 60 min |
| Max duration (minutes) | `chat.generationMaxDurationMs` | 240 min |

Idle timeout resets when new tokens arrive; applies to the next generation without restart. Either limit may be set to `0` to disable it.

**Sub-agent recovery** is journal reconcile, not a heartbeat/stall watchdog. `heartbeatIntervalMs`, `heartbeatDeadMs`, `progressStallMs`, and `duplicateToolCallThreshold` were removed from `sub-agents.json`. Wall-clock for one attempt is `defaultTimeoutMs` / per-type `timeoutMs` (P8-D `limits.wallClockMs`). Crash/timeout retry is the policy table.

Existing `~/.minnow/runs/registry/` files are **left in place** and never imported into the journal (no last-write-wins). The journal at `~/.minnow/agents/<parentChatId>/journal.jsonl` is the record. Registry PUT/POST return 410.

---

## 6. Integrations

### Search (`search.json`)

| Setting | Description |
|---------|-------------|
| Provider | `searxng`, `tavily`, `brave`, `duckduckgo`, `disabled` |
| SearXNG base URL | Or managed instance from Servers |
| Brave / Tavily API keys | |
| Fallback chain | Ordered providers when primary fails |
| Result count | |

### Deep Research (`research.json`)

| Group | Settings |
|-------|----------|
| Research model | Provider + model |
| Search override | Optional provider for research runs |
| Research loop | Max/min rounds, max time/loop, run timeout, max empty rounds |
| Extraction & synthesis | Extraction timeout, concurrency, max URLs/round, max content chars, synthesis window |
| Final report | Max report tokens |

### Servers

Managed **SearXNG** install/start/stop (`~/.minnow/servers/`).

### Tools (`tools.json` + `config.json`)

**Global:**

| Setting | Key |
|---------|-----|
| Constrained tool calls | `toolCalls.useConstrainedDecoding` |
| Tool result cache | Session-scoped (`toolCache.enabled`) |
| Limit tool result size | `toolOutput.enabled` (default on) |
| Maximum characters per result | `toolOutput.maxChars` (default 128000; clamp 8000–2000000) |

**Per-tool permissions:** each of **105 built-in tools** exposed in a default build (`off` / `ask` / `full`); the full catalog is **112** (seven email tools are hidden while that app is release-gated). MCP servers add additional `mcp__…` tools with the same permission model.

### Browser (`config.json` → `browser`)

| Setting | Key |
|---------|-----|
| Allow navigation | `browser.allowNavigate` |
| Restore browser tabs | `browser.restoreBrowserTabs` |
| Allowed origin patterns | `browser.allowedOriginPatterns` |
| DevTools dock | `filePanel.previewDevToolsDock` (session state) |

Preview panel automation for `browser_*` tools (Electron desktop shell only).

#### Built-in tools (catalog)

| Category | Tools |
|----------|-------|
| **Web** | Web search, Wikipedia, Fetch page, Web RAG |
| **Utility** | Date & time, Calculate, Read/write clipboard, System info, Ask question, Set chat mode, Create chat with mode, Launch Minnow app, Propose mode switch, Save memory, Recall chat context, Recall turn full |
| **Files** | List directory, Read file, Read file lines, Save file, Append file, Insert at line, Replace in file, Search in file, Grep, Make directory, Move/rename, Copy file, Delete path, Find files, File metadata |
| **Git** | Status, Diff, Log, Add, Commit, Checkout |
| **Code** | Run command, Read command log, List/stop running commands, Start/stop background command, Run JavaScript, Run Python, Repo map, Find symbol, Who calls, Read symbol, Explain symbol |
| **Agents** | Spawn/cancel/list/get sub-agent status, Board init/update/set autonomy/get state/report, Delegate tasks, Issue add/update/link/get state |
| **Browser** | List tabs, Navigate, Request origin access, Snapshot, Click, Fill, Eval, Screenshot |
| **Brain** | Search, Read page, List pages, Write page, Append log, Ingest source |
| **LSP** | Get diagnostics, List LSP servers |
| **Skills** | Load Impeccable context, Run Impeccable |

No catalog entries carry an `appId`. The catalog is 105 built-in tools, all shipped.

### Skills (`skills.json`)

Per skill: enabled/disabled. Custom SKILL.md authoring. **Caveman** skill has intensity setting. **16** skills are bundled; everything else installs from **Skills Library**.

### Skills Library (`skills-library`)

Curated third-party `SKILL.md` packs (Matt Pocock, Addy Osmani, Superpowers, last30days, Browserbase) browsed and installed per-skill from pinned GitHub commits. Installs land in `~/.minnow/skills/<id>/` with provenance in `installed-skills.json` and are enabled immediately. Offline browse falls back to the shipped indexes under `src/skills/library/index/`.

### MCP servers (`~/.minnow/mcp/`)

Per server: id, label, description, command, args, env, enabled. Built-in Context7 server. **Context7 API key** — Settings → MCP password field; encrypted in `~/.minnow/mcp/secrets.json` (or `CONTEXT7_API_KEY` env var).

### Language servers (`lsp.json`)

Per bundled LSP: install/uninstall, enable/disable. See Settings → Language bundles.

### Editor

**Ghost text** (`config.editorAiCompletion`): enable, model source (chat vs pinned), debounce, prefix/suffix limits, temperature, max tokens, import context, LSP hover, native FIM, completion cache.

**Code editing** (`config.editorSettings`): word wrap, show whitespace, font size, tab size.

**Intent mode** (`config.editorIntentMode`): enabled by default, idle debounce, trigger prefix (sigil), max tokens, and an optional provider/model pin (empty = follow the ghost-text binding).

### Webhooks (`webhooks.json`)

| Setting | Description |
|---------|-------------|
| Allow local HTTP | `webhooks.allowLocalHttp` (dev) |
| Per subscription | Label, URL, events, enabled, HMAC secret |
| Events | `chat.completed`, `session.created`, `scheduler.job_completed` |

### OAuth (`config.oauth` + `oauth/`)

Google and Microsoft: client ID, client secret (Microsoft: tenant ID). Tokens encrypted under `~/.minnow/oauth/`.

---

## 7. Advanced

### Health & diagnostics

Subsystem probes, grouped errors, and a local log tail. Nothing is sent off-device.

### Orchestration (`config.supervisor`)

No Settings page. Board-facing defaults live under Settings → **Autopilot**. Low-level supervisor keys are edited in `config.json` (defaults in [`server/config/validators.js`](../../server/config/validators.js)).

| Setting | Default |
|---------|---------|
| `enabled` | `true` |
| `autoResume` | `true` |
| `repetitionDetection` | `true` |
| `llmEscalation` | `true` |
| `askUserOnBudgetExhausted` | `true` |
| `stallMs` | `30000` |
| `maxRetriesPerTask` | `3` |
| `orchestratorHeartbeatMs` | `90000` |
| `inProgressNoRunMs` | `45000` |
| `spawnStuckMs` | `30000` |
| `parentSilenceAfterToolMs` | `20000` |
| `subAgentToolSilenceMs` | `60000` |
| `runRestartCap` | `2` |
| `spawnCapPerTask` | `3` |
| `llmEscalationsPerSession` | `10` |
| `llmEscalationTimeoutMs` | `8000` |
| `tickIntervalMs` | `5000` |
| `escalationProviderId` / `escalationModelId` | |
| `repetition.duplicateToolCallThreshold` | `5` |
| `repetition.sameErrorThreshold` | `3` |
| `repetition.maxRestartsPerRun` | `2` |

Legacy `selfHealing` tier1/tier2 in config (superseded by supervisor + autopilot).

### Evals (`~/.minnow/evals/`)

No Settings page. Headless task packs and runs live under `server/evals/` / `~/.minnow/evals/`. In-app model batteries use the **Bench** app, which is release-gated off in this build.

---

## Settings outside the Settings app

| Location | Settings |
|----------|----------|
| **Chat top bar** | Provider, model, mode, expert, thinking (per chat), work agent |
| **Chat gear drawer** | Temperature, max tokens (per session) |
| **Brain app → Settings** | Brain synthesis, embeddings, code index (`config.brain.*`) |
| **Scheduler app** | Per-job: schedule, prompt, model, enabled |
| **Research app (run panel)** | Per-run: rounds, category, search provider, model |
| **Welcome screen** | Workspace path, recent workspaces |

---

## Session & layout persistence (`config.json`)

Not all exposed in Settings UI:

| Block | Key settings |
|-------|--------------|
| `workspace` | Path, recent paths, dev server settings per path |
| `filePanel` | Sidebar, viewer, split ratio, tabs, preview |
| `terminal` | Open, height, `autoOpenOnAgentRun`, `autoFollowAgentTab` (MIN-242) |
| `titles` | Chat title generation model/settings |
| `goalEval` | /goal loop evaluator model/settings |
| `activePromptProfile`, `activePromptConfigId`, `activeSetupProfileId` | Prompt state |
| `planning.granularity`, `planning.superPlan` | Plan / Super Plan mode settings |
| `workspaceProfiles`, `workspaceProfileAutoApply` | Per-workspace setup profiles |

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `MINNOW_HOME` | Override `~/.minnow` |
| `PORT` | Dev server port |
| `MINNOW_NETWORK` | `local` / `lan` (overrides Settings network access) |
| `MINNOW_BROWSER` | Open system browser instead of Electron |
| `MINNOW_HEADLESS` / `BROWSER=none` | Don't auto-open window |
| `TOOLS_ALLOW_ALL_PATHS` | Bypass workspace path restriction |
| `MINNOW_OAUTH_REDIRECT_BASE` | OAuth redirect override |
| `MINNOW_DEBUG` | Verbose server logging |
| `MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION` | UI tools in headless CLI |
| `MINNOW_PLUGIN_UNSAFE` | Unsigned tool plugins |
| `MINNOW_TTS_USE_COMPILE` | Compiled TTS path |
| `MINNOW_ELECTRON` | Internal Electron flag |
| `MINNOW_TEST` | Test mode |

Full table: [commands.md](../contributor/commands.md#environment-variables).

---

## Vite-only `localStorage` fallbacks (`npm run dev`)

| Key | Content |
|-----|---------|
| `minnow.tools` | Tool toggles + web search keys |
| `minnow-sessions-v1` | Legacy sessions |
| `minnow.userRules` | Rules mirror |
| `minnow.theme`, `minnow.theme.followSystem`, `minnow.theme.family` | Theme (FOUC cache; canonical file is `appearance.json`) |

Most features require `npm start` for full persistence.

---

## Persistence file map

| File | What it holds |
|------|---------------|
| `config.json` | Global settings (sampler, voice, autopilot, supervisor, memory, synthesis, editor, browser, …) |
| `tools.json` | Per-tool enable + permissions |
| `search.json` | Web search |
| `research.json` | Deep Research |
| `sub-agents.json` | Sub-agent types + globals |
| `work-agents.json` | Work agent overrides |
| `rules.json` | User rules |
| `skills.json` | Skill enable flags |
| `providers/<id>/` | LLM provider profiles + secrets |
| `mcp/` | MCP server configs |
| `lsp.json` | Language servers |
| `webhooks.json` | Webhook subscriptions |
| `oauth/` | Encrypted OAuth tokens |
| `memory/` | Memory entries + vectors |
| `sessions/sessions.db` | Chats, per-chat model/mode/thinking (SQLite; lazy history + FTS search; legacy `state.json` → `.migrated`) |
| `profiles/` | Setup profile bundles |
| `prompts/` | Prompt overrides |
| `evals/` | Eval packs + runs |
| `email/`, `scheduler.json` | App-specific data |
| `appearance.json` | Theme family/mode, custom colors, fonts |

---

## Source of truth in code

| Concern | File |
|---------|------|
| Searchable field catalog | [`src/ui/settings-catalog.ts`](../../src/ui/settings-catalog.ts) |
| Section IDs & nav | [`src/ui/settings-page-types.ts`](../../src/ui/settings-page-types.ts) |
| Section renderers | [`src/ui/settings-sections.ts`](../../src/ui/settings-sections.ts) |
| Config normalization | [`server/config/validators.js`](../../server/config/validators.js) |
| Default meta scaffold | [`server/config/home.js`](../../server/config/home.js) |
| Tool definitions | [`src/tools/definitions.ts`](../../src/tools/definitions.ts) |

---

## Agent settings tools

Desktop and General modes include the **`settings`** tool group (`search_settings`, `get_settings`, `update_settings`).

| Tool | Permission | Notes |
|------|------------|-------|
| `search_settings` | `full` | Returns catalog metadata (key, label, type, sensitivity) — never values |
| `get_settings` | `full` | Server-backed fields from `~/.minnow`; secrets → `[redacted]`; browser fields enriched client-side |
| `update_settings` | `ask` | Approval strip shows human diff; secret/dangerous fields require `confirmed: true` after approval |

**Registry:** [`src/settings/field-registry.ts`](../../src/settings/field-registry.ts) maps catalog keys → `config.json`, `tools.json`, `search.json`, etc. Generated server mirror: `server/settings/registry-manifest.json` (`npm run settings-registry:generate` / `prebuild`).

**HTTP API:** `GET /api/settings/catalog`, `POST /api/settings/read`, `POST /api/settings/update` ([`server/settings/middleware.js`](../../server/settings/middleware.js)).

**Client sync:** [`src/settings/client-sync.ts`](../../src/settings/client-sync.ts) applies `clientPatches` (notifications, theme), refreshes settings sections, dispatches `minnow:settings-changed`.

**Prompt:** [`src/chat/prompts/tool-usage/manage-settings.md`](../../src/chat/prompts/tool-usage/manage-settings.md) (gated when `update_settings` is enabled in General/Desktop).

Implementation: [`src/ui/settings-agent-center.ts`](../../src/ui/settings-agent-center.ts).
