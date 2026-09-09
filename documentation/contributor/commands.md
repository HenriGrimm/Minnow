# Command reference

Every npm script, the headless CLI, smoke/maintenance scripts, and environment variables. Source of truth: [`package.json`](../../package.json). Setup from source: [setup-from-source.md](setup-from-source.md). System map: [architecture.md](architecture.md) and [`../context.md`](../context.md).

For UI key bindings (composer, editor, file tree, terminal), see [Keyboard shortcuts](../manual/reference/keyboard-shortcuts.md).

## Running & building

| Command | Description |
|---------|-------------|
| `npm start` | **Recommended.** `node server.js` → Vite + tool server + `~/.minnow` APIs + Electron desktop shell. |
| `npm run dev` | Vite only (UI/HMR). Most server features unavailable. |
| `npm run desktop` | Alias for `electron:dev`. |
| `npm run electron:dev` | `concurrently` Vite (HMR, `MINNOW_ELECTRON=1`) + Electron via `scripts/electron-dev.mjs`. |
| `npm run electron:build` | Compile the Electron main/preload (`electron/tsconfig.json`) + rename preload + write `electron/dist/package.json` version stub. |
| `node scripts/verify-github-update-feed.mjs` | Compare GitHub `latest*.yml` sizes to attached installers (`v<package.json version>` or pass a tag). |
| `npm run electron:prod` | Full build + Electron build, then run the packaged main against `dist/`. |
| `npm run build` | `tsc && vite build` → `dist/`. `prebuild` regenerates `src/skills/builtin-manifest.json`. |
| `npm run preview` | `vite preview` of the production build (no tool API). |
| `npm run package` | Build + Electron build + **electron-builder** installer → `release/pkg` (Windows NSIS, macOS dmg/zip, plus `latest.yml` auto-update feed metadata; never uploads — see [releasing](../maintainer/releasing.md)). |
| `npm run package:win` / `package:mac` / `package:linux` | Package a single platform. On Windows/macOS, **AppImage** needs Docker — use `npm run package:linux:docker`. `package:win` / `package:linux` run `sandbox:ensure-helper` first (Linux ELF for Landlock; WSL build on Windows). |
| `npm run package:dir` | Same, unpacked directory (`--dir`). |
| `npm run package:clean` | Clean the `release/` output. |
| `npx tsc --noEmit` | Typecheck only. |

## Generated artifacts

`prebuild` runs these automatically before `npm run build`; run them by hand when you change a source of truth and want the generated file refreshed without a full build.

| Command | Regenerates |
|---------|-------------|
| `npm run wiki:generate` | `server/product-wiki/catalog.json` from `documentation/` — **run after editing any wiki page** |
| `npm run test:product-wiki` | Catalog sync + manual copy gates (also CI job **product wiki**; not part of `npm test`) |
| `npm run wiki:stage` | Stages the GitHub Wiki tree (see [wiki-publishing](../maintainer/wiki-publishing.md)) |
| `npm run settings-registry:generate` | `server/settings/registry-manifest.json` from the settings catalog |
| `npm run skills-library:index` | Skills Library index |
| `npm run check:icons` | Fails when an icon reference has no asset |

## Headless CLI (`minnow run`)

Drives one agent turn without the SPA. Requires the tool server (`npm start`) or pass `--start-server`. Entry: [`bin/minnow.mjs`](../../bin/minnow.mjs) → `src/headless/cli-main.ts`.

```bash
minnow run --workspace . --agent builder --mode build \
  --prompt "Summarize README.md" --json-out run.json

# or via npm
npm run minnow:run -- --prompt "Reply OK" --json
```

Flags (`minnow run --help` for the authoritative list):

| Flag | Purpose |
|------|---------|
| `--prompt <text>` / `--stdin` | The user message (or read from stdin). |
| `--workspace <dir>` | Workspace root for file/git tools. |
| `--agent <id>` | Work agent to use. |
| `--mode <id>` | `general` / `build` / `plan` / `orchestrate` / `debug`. |
| `--model <id>` / `--provider <id>` | Override model / provider. |
| `--profile <id>` | Prompt profile / setup bundle. |
| `--base-url <url>` | Server origin (default detected; e.g. `http://127.0.0.1:9473`). |
| `--start-server` | Start a tool server for the run. |
| `--server-timeout <ms>` | Server readiness timeout. |
| `--json` / `--json-out <file>` | Machine-readable result to stdout / file. |
| `--max-tool-turns <n>` | Cap tool-call iterations. |
| `--no-approval` / `--auto-reject-questions` | Non-interactive tool/question handling. |
| `--persist-chat` / `--chat-id <id>` / `--chat-name <name>` | Save the transcript into `~/.minnow/sessions`. |
| `--scheduler-run` | Marks a scheduler-originated run. |
| `--minnow-home <dir>` | Override `~/.minnow`. |
| `--quiet` | Suppress progress logs. |

UI-only tools (e.g. `ask_question`) fail with a clear error in headless mode unless you opt into unsafe automation (`MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION`).

## Tests

`npm test` runs the full suite via [`test/run-all.mjs`](../../test/run-all.mjs) — it discovers every `test/**/*.test.{js,mjs,mts,ts}` file and runs the correct runner/loader per path (see [`test/test-config.mjs`](../../test/test-config.mjs)). New test files are included automatically; `npm run test:check-coverage` fails CI when a file would be orphaned. Worker parallelism defaults to `min(16, availableParallelism())`; override with `MINNOW_TEST_CONCURRENCY`.

**Memory:** every runner preloads [`test/assert-dom-safe.mjs`](../../test/assert-dom-safe.mjs). Without it a *failing* `assert.equal(document.querySelector('.x'), null)` hands a happy-dom node to node:assert, which inspects it at `depth: 1000` and Myers-diffs the result — synchronous, unbounded typed-array allocation that `--max-old-space-size` cannot cap, and enough to freeze a 64 GB workstation from a single test process (measured: one child at 49 GB and still climbing). The guard compares DOM operands itself and reports a short descriptor (`<section.board-root>`) instead. Do not remove the preload, and prefer `assert.ok(!el)` over comparing elements when adding assertions.

**CI (MIN-383):** [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on pull requests and pushes to `main`: `npm ci` → `test:check-coverage` → `npx tsc --noEmit` → `npm test` on `windows-latest`, `ubuntu-latest`, and `macos-latest` (includes `test/headless/`). Require the **`ci`** status check on `main` before merge ([`.github/BRANCH_PROTECTION.md`](../../.github/BRANCH_PROTECTION.md)).

Scoped suites (each delegates to `node test/run-all.mjs --suite <name>`):

| Command | Area |
|---------|------|
| `npm run test:memory` | Memory store + API |
| `npm run test:brain` | Brain wiki / CORTEX |
| `npm run test:engine` | Retrieval engine |
| `npm run test:lsp` | LSP integration |
| `npm run test:mcp` | MCP servers |
| `npm run test:browser` | CDP / browser preview tools |
| `npm run test:skills` | Skills loader + clients |
| `npm run test:impeccable` / `test:skills-impeccable` | Impeccable skill + `/impeccable` |
| `npm run test:attachments` | Workspace refs + document readers |
| `npm run test:research` | Deep research |
| `npm run test:benchmark` | Benchmark app |
| `npm run test:evals` | Eval harness |
| `npm run test:webhooks` | Outgoing webhooks |
| `npm run test:notifications` | Notification inbox |
| `npm run test:servers` | Managed server processes |
| `npm run test:plugins` | Tool plugin scan/loader |
| `npm run test:terminal-pty` | Terminal PTY session (live server) |
| `npm run test:ui-designer` | UI Designer agent |
| `npm run test:settings` | Settings registry |
| `npm run test:orchestrator` / `test:board` | Orchestrator V2 journal suite — see [orchestrate-board-testing.md](orchestrate-board-testing.md) |
| `npm run test:check-coverage` | Orphan test detection (also in CI) |

Most TS/UI suites run under `tsx` with `--import ./test/test-loader.mjs` (stubs `.css` + xterm); some use `--experimental-test-module-mocks`.

## Skill maintenance

| Command | Description |
|---------|-------------|
| `npm run impeccable:sync` | Re-vendor Impeccable into `src/skills/impeccable/`. |
| `npm run impeccable:update` | Update upstream Impeccable, then re-sync. |
| `npm run impeccable:detect` | Anti-pattern scan of `src/` + `index.html` (exit `2` = issues found). |
| `npm run caveman:sync` | Refresh the upstream Caveman `SKILL.md`. |
| `npm run matt-pocock-skills:sync` | Re-vendor the Matt Pocock skill pack. |
| `node scripts/build-benchmark-packs.mjs` | Rebuild benchmark task packs into `public/benchmark-packs/` (no npm alias). |
| `npm run report:bundle-size` | Print production chunk sizes from `dist/assets` (run after `npm run build`). |
| `npm run report:bundle-size:ci` | Same as above; exits non-zero when entry chunk exceeds 1500 KB or data packs ship as JS. |

## Orchestrate board dev tools

| Command | Description |
|---------|-------------|
| `npm run test:orchestrator` / `test:board` | V2 journal suite (`test/orchestrator/` + scenario catalog). See [orchestrate-board-testing.md](orchestrate-board-testing.md). |
| `npm run board:scenario-contract` | Validate the Settings board-testing catalog (PR gate). |
| `npm run fake-model` | Local OpenAI-v1 stub for manual board runs. `npm run fake-model -- --register` adds provider `fake-board`. |
| `npm run check:board-log` | Retired (exit 1). V1 JSONL invariants were deleted in MIN-713. V2 history is the journal under `~/.minnow/boards/`. |

## Smoke scripts

Run with the server up (default port 9473 — substitute yours). API calls need the per-boot session token from `~/.minnow/session-token`:

```bash
npx tsx scripts/sa16-smoke.mjs http://localhost:9473       # general/sub-agent smoke
node test/terminal-stream.test.mjs http://localhost:9473   # terminal stream API
npx tsx scripts/step16-memory-smoke.mjs http://localhost:9473
```

Other `scripts/*.mjs` cover stepwise feature smokes, Electron launch, token/CSS generation, and migrations — see the [`scripts/`](../../scripts/) folder.

## Environment variables

| Variable | Effect |
|----------|--------|
| `PORT` | Server/Vite port (default 9473, falls back to next free). `5173` is ignored and coerced to 9473 — it's reserved for dev servers in your workspace. |
| `MINNOW_HOME` | Override the `~/.minnow` data directory. |
| `MINNOW_BROWSER=1` | Open a system browser tab instead of the Electron shell. |
| `MINNOW_HEADLESS=1` / `BROWSER=none` | Don't auto-open any window. |
| `MINNOW_ELECTRON=1` | Internal flag set when running under Electron. |
| `TOOLS_ALLOW_ALL_PATHS=1` | Let file/git tools resolve outside the workspace root (use with care). |
| `MINNOW_OAUTH_REDIRECT_BASE` | Override the OAuth redirect base URL. |
| `MINNOW_NETWORK` | `local` (default) or `lan` — bind dev server to loopback vs all interfaces. Overrides `config.json` → `server.networkAccess`. Restart after changing Settings. On Windows, allow inbound TCP on the dev port in Firewall if LAN clients cannot connect. See [lan-companion.md](lan-companion.md). |
| `MINNOW_DEBUG` | Verbose server logging; enables Settings → Advanced → Board testing and `/api/orchestrate/board-testing/*` (with `MINNOW_TEST=1` for CI harnesses). |
| `MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION` | Allow UI-only tools in headless runs. |
| `MINNOW_PLUGIN_UNSAFE` | Allow unsigned/unsafe tool plugins. |
| `MINNOW_TTS_USE_COMPILE` | Opt into compiled TTS path. |
| `MINNOW_TEST` | Set during test runs. |
