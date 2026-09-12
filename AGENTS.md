# AGENTS.md

Guidance for AI coding agents (Cursor, Claude Code, etc.) working in the Minnow repo.

## Overview

Minnow is a **Vite + TypeScript SPA** plus a **Node tool server** (`server.js`) and an **Electron shell** (Minnow Shell). It is a full agentic **development workspace** — editor, agents, terminal, git, issues, planning, knowledge, and local model hosting in one app — running on LM Studio and other OpenAI-compatible providers. The surfaces share one chat engine, one tool set, one session store and one workspace root; that shared spine is the product, so changes that break it matter more than they look.

**Code is the product surface.** Every other app supports work done there; when a change is ambiguous, favour the build loop over rail completeness. Product framing lives in [`PRODUCT.md`](PRODUCT.md).

- **Four composer modes** — General, Build, Plan (no-destructive guard), Debug — plus **Orchestrate** (opens the Boards surface from the sidebar, not a chat; not in the composer picker) and **Onboarding** as non-composer modes. Persisted `'desktop'` and `'email'` chats remap to **General** via `normalizeModeId`; **`'super-plan'` remaps to `'plan'`** while Super Plan is disabled for release (`src/config/super-plan-enabled.ts`) — the mode id stays valid in the persisted schema so old records load, and `listModes()` filters it out. Defined in [`src/chat/modes/registry.ts`](src/chat/modes/registry.ts); prompts in [`src/chat/prompts/modes/`](src/chat/prompts/modes/). Reef mode was removed (MIN-473) — do not reintroduce it.
- **103 built-in tools** across web / utility / files / git / code / agents / browser / lsp ([`src/tools/definitions.ts`](src/tools/definitions.ts)). Includes `issue_*` tools and the read-only `minnow_docs_*` tools (search the shipped user manual under `documentation/manual/` only). No entries carry an `appId`; the shipped catalog is 103. V1 board tools (`board_init` and siblings) were deleted in MIN-715.
- **Built-in slash skills** (19): core helpers (`git-commit`, `code-review`, `fix-ci`, `ask-user`, `plan-work`, `orchestrate-plan`, …), `impeccable` (default-on), `caveman`, `ui-designer`, `partymode`. Third-party packs — including the **Matt Pocock pack** (19 skills) — install from **Settings → Skills Library**; nothing else is bundled. See [`documentation/context.md`](documentation/context.md) § Skills.
- **Minnow apps — released:** **Code** (the primary surface), Source Control, Models, Brain, Scheduler, **Issues**, Settings — all `core` (not user-disableable). Legacy `#/app/chat` redirects to `#/app/code/chat`. **Hidden** (`releaseState: 'hidden'`): Compare, Bench, Experts (MIN-471), and **Research** (disabled for release — broken) — code stays in tree but is omitted from dock, onboarding, Settings, routes, notifications, and `launch_minnow_app`. Research's `deep-research` Settings section is omitted too, since its config has no other consumer. Registry: [`src/os/app-registry.ts`](src/os/app-registry.ts).
- **Persistence** lives under `~/.minnow` when the tool server runs.

The **authoritative reference** is [`documentation/context.md`](documentation/context.md) — read it before touching unfamiliar subsystems. Product overview: [`README.md`](README.md). Setup and scripts: [`documentation/contributor/setup-from-source.md`](documentation/contributor/setup-from-source.md) and [`documentation/contributor/commands.md`](documentation/contributor/commands.md). Full doc index: [`documentation/`](documentation/README.md).

## Running the app

- **`npm start`** is the recommended dev command — Vite + the Node tool server on port **9473** (or next free port if `PORT` is set) and **launches the Electron desktop shell by default**. `MINNOW_BROWSER=1` opens the system browser instead; `BROWSER=none` or `MINNOW_HEADLESS=1` suppresses auto-open. `npm run desktop` / `npm run electron:dev` are HMR-friendly Electron aliases.
- **`npm run dev`** is Vite-only (no tool server) — fine for pure UI work, but most tool-dependent features won't function.
- **Headless CLI:** `minnow run --prompt "…"` (or `npm run minnow:run -- --prompt "…"`) drives the same generations + server tools without the SPA. Requires `npm start` (or `--start-server`). See `minnow run --help`.
- Health checks: `curl http://localhost:9473/api/tools/ping`, `/api/config/ping`, `/api/memory/ping`, `/api/brain/ping` (substitute your `PORT` if overridden).
- **LM Studio headless daemon** (`llmster`): install with `curl -fsSL https://lmstudio.ai/install.sh | bash`; `lms daemon up && lms server start`; `lms get <model> -y`; `lms load <model> -y`. CLI at `~/.lmstudio/bin/lms`.

## Testing

- **`npm test`** runs the full suite via [`test/run-all.mjs`](test/run-all.mjs) — auto-discovers `test/**/*.test.{js,mjs,mts,ts}` and batches by runner (`node --test`, `tsx` + [`test/test-loader.mjs`](test/test-loader.mjs)). New test files under `test/` are picked up with zero `package.json` edits.
- **`npm run test:check-coverage`** fails if any discoverable test file is not covered (CI gate).
- **CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on every PR + push to `main` — `npm ci`, `test:check-coverage`, `npx tsc --noEmit`, `npm test` (Windows + Ubuntu + macOS), plus fast Ubuntu jobs **product wiki** (`npm run test:product-wiki`) and **board scenario contract**. Enable branch protection per [`.github/BRANCH_PROTECTION.md`](.github/BRANCH_PROTECTION.md).
- **`npx tsc --noEmit`** for type checking (no separate ESLint config).
- Scoped suites: `npm run test:memory|brain|engine|lsp|mcp|browser|skills|attachments|research|benchmark|evals|webhooks|notifications|voice|servers|plugins|terminal-pty|ui-designer|scheduler|onboarding|issues|orchestrator` (`test:board` aliases `test:orchestrator`). See `package.json` for exact globs. Board testing: [documentation/contributor/orchestrate-board-testing.md](documentation/contributor/orchestrate-board-testing.md).
- Many TS/UI suites run under `tsx` with `--import ./test/test-loader.mjs` (the loader stubs `.css` and xterm). Some use `--experimental-test-module-mocks`.

## Building & packaging

- **`npm run build`** → `tsc && vite build` → `dist/`. The `prebuild` step generates `src/skills/builtin-manifest.json`.
- **`npm run package`** → build + `electron:build` + `electron-builder` (Windows NSIS → `release/`). `package:dir` produces an unpacked directory.

## Performance budgets (MIN-400)

Perf regressions fail CI the same way as `impeccable:detect` — loudly and with numbers.

- **Bundle ceilings** live in [`budgets.json`](budgets.json) (entry JS/CSS, largest lazy JS chunk, total `dist/assets` excluding benchmark data packs). After `npm run build`, run `npm run check:performance-budgets` (or `npm run report:bundle-size -- --check`). Breaches print the chunk name and KB delta vs the limit and vs [`scripts/bundle-size-baseline.json`](scripts/bundle-size-baseline.json).
- **Raising a budget** requires editing `budgets.json` in the same PR with a short rationale in the commit/PR body, then refresh the baseline: `npm run build && node scripts/check-performance-budgets.mjs --update-baseline`.
- **Startup** is measured at `markAppReady()` ([`src/boot/app-ready.ts`](src/boot/app-ready.ts)); boot metrics surface in the dev console when `MINNOW_DEBUG=1`, under Settings → About → Performance diagnostics, and in CI via the happy-dom harness (`test/boot/boot-budget-ci.test.mts`).
- **Long tasks (dev only):** with `MINNOW_DEBUG=1`, main-thread stalls ≥100ms log to the console (`src/boot/long-task-observer.ts`) — local only, no telemetry.

## Key gotchas

- `postinstall` runs `scripts/sync-impeccable-skill.mjs` (vendors the Impeccable skill) and `scripts/ensure-electron.mjs`. Both are expected and idempotent.
- **Browser-only tools** (`get_datetime`, `calculate`, `ask_question`, sub-agent/board tools, mode handoff, `browser_*`) run client-side; calling them via `POST /api/tools` returns "Not implemented".
- `browser_*` automation requires the Electron shell and an origin allowlist; hidden in a plain browser tab.
- The `[providers] fetch failed` log on startup is normal without LM Studio (provider discovery can't reach `localhost:1234`).
- **Streaming SSE** is parsed in [`src/api/sse-parse.ts`](src/api/sse-parse.ts) (event boundaries + glued JSON); non-streaming fallback uses `parseCompletionResponseBody` — do not call `Response.json()` on the generations shim. Some non–OpenAI providers (e.g. `llmster`) may still yield empty text; verify the provider's `chatCompletionsPath` is `/v1/chat/completions`.
- **Secrets are encrypted** at rest with `~/.minnow/.key`. Deleting/rotating the key makes existing encrypted secrets unrecoverable.
- **Path safety:** file/git tools resolve under the workspace root unless `TOOLS_ALLOW_ALL_PATHS=1`.
- **LAN access** is opt-in (`Settings → General → Network access` or `MINNOW_NETWORK=lan`); default is loopback-only — restart after toggling.
- **Release gating:** an app is only reachable when `releaseState: 'released'` in [`src/os/app-registry.ts`](src/os/app-registry.ts). Tests and code for hidden apps (Compare, Bench, Experts) still run — don't delete them — but nothing user-facing may assume they are visible. New or unfinished apps ship `hidden` first.
- **Plan mode** denies mutating file edits and git writes; allows `save_file`/`make_directory` under `documentation/plans/` only (see `tool-groups.ts` + `plan-write-guard.ts`). Shell/code-exec is allowed per the mode matrix (MIN-332). **`issue_*` tools stay allowed** in Plan; the default **Planner** work-agent `allowedTools` must include that group or send-path filtering strips them even when the mode matrix allows them.
- **GitHub in agent chats:** when tools include `execute_command`, the composed system prompt appends **`github-cli`** guidance — use the local **`gh`** CLI for this repo's PRs, issues, and CI; do not scrape github.com via browser or web-fetch tools (MIN-558).

## Conventions

- Match the surrounding code's style, naming, and comment density.
- Application CSS uses `--mn-*` tokens; hex/rgba literals live only in [`src/styles/tokens.css`](src/styles/tokens.css). See [`DESIGN.md`](DESIGN.md).
- Keep [`documentation/context.md`](documentation/context.md) updated when you ship a feature that changes architecture, APIs, or storage.
- **User-facing docs describe what ships.** `documentation/manual/` and `README.md` cover the build a reader installed — no competitor comparisons, no "replaces X", nothing in the future tense. Direction goes in [`documentation/ROADMAP.md`](documentation/ROADMAP.md), which is the only page allowed to discuss unshipped work. Release-gated apps are an implementation detail: keep them out of the manual and the README.

## Cursor Cloud specific instructions

Dependencies are already installed by the startup update script (`npm install`). Notes below are non-obvious caveats for running/testing in the headless cloud VM; standard commands live in [setup-from-source.md](documentation/contributor/setup-from-source.md) and [commands.md](documentation/contributor/commands.md).

- **Headless startup:** the VM has no display/Electron GUI. Start the stack with `MINNOW_HEADLESS=1 BROWSER=none npm start` and open the SPA at `http://localhost:9473` in the in-VM browser. Plain `npm start` tries to launch the Electron desktop shell.
- **API auth gate:** every `/api/*` call needs the per-boot token — `curl -H "X-Minnow-Token: $(cat ~/.minnow/session-token)" http://localhost:9473/api/tools/ping`. A tokenless request returns `401` (the gate working), not a broken server.
- **Chatting without LM Studio:** run `node scripts/fake-model-server.mjs --port 18765` for an OpenAI-v1 stub. The reserved `fake-board` provider id is intentionally inert in the UI — `proxyModels` in [`server/providers/proxy.js`](server/providers/proxy.js) returns an empty model list for it unless the in-server board-testing fake host is running (needs `MINNOW_DEBUG=1`). To get a UI-selectable model, register the stub under a **different** provider id and set it active: `POST /api/providers` with `{"id":"local-fake","label":"Local Fake (dev)","baseUrl":"http://127.0.0.1:18765","apiKind":"openai-v1"}`, then `POST /api/providers/local-fake/set-active`. A general-mode chat then streams the stub's default reply (`Done.`).
- **Benign startup noise:** `[servers] auto-provision searxng failed: tar: This does not look like a tar archive` is expected in the network-restricted VM and does not block the server.
- **Test suite reality:** `npm test` runs end to end, but a small number of tests currently fail on `main` for reasons unrelated to environment setup (in-code default/fixture spec drift — e.g. `test/config/editor-ai-completion-meta.test.js`, the fake LSP formatting fixture). Don't assume a fully green suite; scope expectations to the area you touch.
- **Fixture side effects:** the scratch Minnow homes under `test/fixtures/` (`lsp-*-home`, `mcp-secrets-home`) are runtime-generated — tests wipe and rebuild them each run, and they are gitignored (SQLite DBs, configs, diagnostics logs, secrets). No need to reset them before committing. If any other tracked fixture gets dirtied, reset with `git checkout -- test/fixtures/ && git clean -fd test/fixtures/`.
