---
name: min-61-52-47-57-bug-fix-batch
overview: Four independent, small-surface bug fixes filed by the 2026-09-29 review — the onboarding Ollama probe building a `/v1/v1/models` URL (MIN-61), the headless CLI launcher pinning the child's cwd to the Minnow install so relative `--workspace` / `--json-out` resolve in the wrong project (MIN-52), LSP test teardown calling the persistent default-workspace setter after deleting `MINNOW_HOME` and therefore writing the developer's real `~/.minnow/config.json` (MIN-47), and the scheduler admitting a job into `activeJobIds` plus persisting `running: true` outside the protected `try/finally` so a preparation failure leaks one of two global run slots forever (MIN-57). Each task is one commit, they touch disjoint files, and one follow-up task adds a runner-wide test-home guard so MIN-47 cannot silently regress.
todos:
  - id: W1-A
    content: "Wave 1: Fix the Ollama probe URL and add exact-request-URL probe tests (MIN-61)"
    status: pending
  - id: W1-B
    content: "Wave 1: Correct the documented Ollama base URL (MIN-61 doc follow-on)"
    status: pending
  - id: W1-C
    content: "Wave 1: Preserve caller cwd for the headless CLI child (MIN-52)"
    status: pending
  - id: W1-D
    content: "Wave 1: Add a non-persistent workspace reset helper and stop test teardown writing the real profile (MIN-47)"
    status: pending
  - id: W1-E
    content: "Wave 1: Put the whole scheduler run lifecycle inside try/finally and isolate bad jobs per tick (MIN-57)"
    status: pending
  - id: W2-A
    content: "Wave 2: Runner-wide test-home guard so tests can never reach the real ~/.minnow (MIN-47 follow-up)"
    status: pending
isProject: true
---

# MIN-61 / MIN-52 / MIN-47 / MIN-57 — bug fix batch

**Date:** 2026-09-30
**Goal:** Fix four unrelated, code-traced defects from the 2026-09-29 review as four self-contained commits, each with an objective regression test.
**Granularity:** medium

## Context

These four issues came out of the 2026-09-29 review. They were picked together because they are small, live in four different subsystems, and have no dependency ordering between them — not because they belong in one commit. **Land one commit per task.**

Every location below was re-verified against the current working tree while writing this plan (the review's line numbers refer to an older revision):

| Issue | Verified today |
|-------|----------------|
| MIN-61 | `src/onboarding/provider-probe.ts:23` is `http://localhost:11434/v1`, and `:51-53` appends `/v1/models` for `openai-v1` → `http://localhost:11434/v1/v1/models`. `src/providers/presets.ts:91` already uses the correct un-suffixed `http://localhost:11434` for the same provider, so the probe is the outlier. There is **no test** covering `probeLocalProviders`. |
| MIN-52 | `bin/minnow.mjs:56` passes `cwd: root`. `src/headless/cli-main.ts:88` resolves `--workspace` against `process.cwd()` and `:132` writes `cli.jsonOut` as given. `tsxCli`, `runner` and the loader URL (`bin/minnow.mjs:13,14,52`) are already absolute, and `spawnMinnowServer` uses its own absolute `APP_ROOT` (`src/headless/preflight.ts:10,71`), so nothing in the child depends on the launcher's cwd. |
| MIN-47 | `test/lsp/workspace-root.test.mjs:62-71` deletes `MINNOW_HOME`, calls `resetMinnowHomeCache()`, **then** `await setWorkspaceRoot(PROJECT_ROOT)`. `server/workspace/root.js:497` aliases that to `setDefaultWorkspaceRoot`, which at `:479-484` writes `config.json`, touches the MRU and may auto-apply a workspace profile — against the real `~/.minnow` by then. Same order in `test/lsp/vite-config-diagnostics.test.mjs:137-146` and `test/lsp/typescript-lsp.integration.test.mjs:70-79`. `test/lsp/typescript7-diagnostics.test.mjs:43-51` and `test/orchestrator/board-git-ensure.test.mjs:149-154` restore the home *before* the persistent setter, so they hit the temp home — still a persistent write, and included here for consistency. There is currently **no** non-persistent reset helper in `server/workspace/root.js`. |
| MIN-57 | `server/scheduler/runner.js`: `activeJobIds.add(jobId)` at `:108`, `running: true` persisted at `:114-118`, `upsertRun` at `:120`, `decryptSecretPayload` at `:127`, `resolveJobRunModel` at `:146`, `resolveJobWorkspacePath` at `:154` — all **before** the `try` at `:173`. The `finally` at `:221-224` only clears child state, and the `running: false` write at `:252-258` sits after the `upsertRun` at `:240`, so a history-write rejection also leaves the flag set. `server/scheduler/tick.js:50` awaits `runStoredJob` inside the job loop with no per-job `catch`, so one throw abandons every remaining due job that tick. |

## Architecture / Key Files

| File | Role | Action |
|------|------|--------|
| `src/onboarding/provider-probe.ts` | Onboarding local-provider port probe | MODIFY (W1-A) |
| `test/onboarding/local-provider-probe.test.mjs` | Exact-URL probe assertions | CREATE (W1-A) |
| `documentation/manual/apps/models.md` | Models app manual page | MODIFY (W1-B) |
| `documentation/manual/get-started/connect-a-model.md` | Connect-a-model manual page | MODIFY (W1-B) |
| `documentation/contributor/setup-from-source.md` | Contributor setup guide | MODIFY (W1-B) |
| `documentation/minnow-junior-developer-guide.html` | Standalone junior-dev guide | MODIFY (W1-B) |
| `bin/minnow.mjs` | Published CLI launcher (spawns the tsx child) | MODIFY (W1-C) |
| `test/headless/cli-launcher-cwd.test.mjs` | Launcher cwd propagation test | CREATE (W1-C) |
| `server/workspace/root.js` | Process default workspace + persistence | MODIFY (W1-D) |
| `test/lsp/workspace-root.test.mjs` | LSP workspace-root suite | MODIFY (W1-D) |
| `test/lsp/vite-config-diagnostics.test.mjs` | LSP vite-config suite | MODIFY (W1-D) |
| `test/lsp/typescript-lsp.integration.test.mjs` | LSP TypeScript integration suite | MODIFY (W1-D) |
| `test/lsp/typescript7-diagnostics.test.mjs` | LSP TS7 suite | MODIFY (W1-D) |
| `test/orchestrator/board-git-ensure.test.mjs` | Board git-ensure suite | MODIFY (W1-D) |
| `test/workspace/workspace-root-test-reset.test.js` | Reset-helper unit test | CREATE (W1-D) |
| `server/scheduler/runner.js` | Scheduled-run subprocess lifecycle | MODIFY (W1-E) |
| `server/scheduler/tick.js` | Due-job dispatch loop | MODIFY (W1-E) |
| `test/scheduler/runner.test.mjs` | Scheduler runner suite | MODIFY (W1-E) |
| `server/config/home.js` | `~/.minnow` resolution | MODIFY (W2-A) |
| `test/run-all.mjs` | Test runner entry | MODIFY (W2-A) |
| `test/config/minnow-home-test-guard.test.js` | Guard unit test | CREATE (W2-A) |

## Wave Breakdown

### Wave 1 — Independent fixes

All five tasks are independent: no shared files, no shared symbols, no ordering. `Depends on:` is omitted for each.

#### Task W1-A: Ollama probe builds `/v1/v1/models` (MIN-61)

- **Build:**
  1. In `src/onboarding/provider-probe.ts`, change the Ollama entry in `PROBE_TARGETS` (line 23) from `http://localhost:11434/v1` to `http://localhost:11434`, matching the `ollama` entry in `SETTINGS_LOCAL_PRESETS` (`src/providers/presets.ts:88-94`).
  2. Delete the inline `modelsPath` ternary inside `probeLocalProviders` (lines 51-52) and derive it from the shared provider-transport helper instead: `import { getDefaultPaths } from '../providers/paths';` then `const { modelsPath } = getDefaultPaths(target.apiKind);`. Keep `probeUrl` and `firstReachableProbe` unchanged.
  3. Do not change the `ProviderProbeResult` shape — `src/onboarding/steps/provider.ts` matches probe results by `baseUrl` (`:398`), seeds `localBaseUrl` from `hit.baseUrl` (`:161`), and registers the provider with `getDefaultPaths(match.apiKind).modelsPath` (`:407-416`); the corrected base URL flows through all three correctly.
  4. Expected diff: ~6 lines in one file.
- **Test:** Create `test/onboarding/local-provider-probe.test.mjs` (node:test, mirroring the style of `test/onboarding/cloud-provider-urls.test.mjs`). Stub `globalThis.fetch` with a recorder that pushes every requested URL and returns `{ ok: true }`, restore the original in a `finally`, `await probeLocalProviders()`, then assert the recorded URL set is exactly `['http://localhost:1234/api/v0/models', 'http://localhost:11434/v1/models', 'http://127.0.0.1:8085/v1/models']` (order-insensitive), assert no recorded URL contains `/v1/v1/`, and assert every result has `reachable: true`. Run `npm run test:onboarding`.
- **Accept:** `probeLocalProviders()` requests `http://localhost:11434/v1/models` exactly once and never requests any URL containing `/v1/v1/`.
- **Touches:** `src/onboarding/provider-probe.ts`, `test/onboarding/local-provider-probe.test.mjs`

#### Task W1-B: Documented Ollama base URL is also wrong (MIN-61 doc follow-on)

- **Build:** Four docs tell users to enter `http://localhost:11434/v1`. With `apiKind: 'openai-v1'` the default `modelsPath` is `/v1/models` (`src/providers/paths.ts:33`) and `normalizeProviderBaseUrl` **preserves** the pathname (`src/lib/normalize-provider-base-url.mjs:22-26`), so a hand-entered `/v1` base URL produces `/v1/v1/models` the same way the probe did. Change the URL to `http://localhost:11434` in:
  - `documentation/manual/apps/models.md:70`
  - `documentation/manual/get-started/connect-a-model.md:30`
  - `documentation/contributor/setup-from-source.md:52`
  - `documentation/minnow-junior-developer-guide.html:366`
  Text only — do not restructure the surrounding prose, and keep the manual in present tense describing what ships.
- **Test:** `npm run test:product-wiki` (the manual copy gate). Then `grep -n "11434/v1" documentation/` returns no matches outside this plan file.
- **Accept:** No file under `documentation/` instructs the user to enter an Ollama base URL ending in `/v1`.
- **Touches:** `documentation/manual/apps/models.md`, `documentation/manual/get-started/connect-a-model.md`, `documentation/contributor/setup-from-source.md`, `documentation/minnow-junior-developer-guide.html`

#### Task W1-C: CLI launcher pins the child's cwd to the Minnow install (MIN-52)

- **Build:**
  1. In `bin/minnow.mjs`, inside `runHeadlessCli`, change the `spawnSync(process.execPath, tsxArgs, { cwd: root, ... })` call (line 55-59) to pass `cwd: process.cwd()`. Leave `root`, `tsxCli`, `runner` and the `testLoader` file URL alone — they are already absolute and must stay that way.
  2. Add a one-line comment above the spawn explaining why: the child resolves `--workspace` and `--json-out` against its cwd (`src/headless/cli-main.ts:88,132`), so pinning cwd to the install directory silently retargets the caller's project.
  3. Do **not** change `src/headless/preflight.ts` — `spawnMinnowServer` already uses its own absolute `APP_ROOT` (`:10,71`), and `server/scheduler/runner.js:176` keeps its explicit `cwd: getAppRoot()` with an absolute `--workspace`, so server-side spawning is unaffected.
  4. Expected diff: 2-3 lines in one file.
- **Test:** Create `test/headless/cli-launcher-cwd.test.mjs`:
  - Start a throwaway `node:http` server on port 0 that answers `GET /api/config/ping` and `GET /api/tools/ping` with `{"ok":true}`, records the JSON body of `POST /api/workspace/open`, and returns 500 for anything else.
  - `mkdtemp` a caller directory and a temp `MINNOW_HOME`.
  - `spawnSync(process.execPath, [path.join(repoRoot, 'bin/minnow.mjs'), 'run', '--prompt', 'noop', '--workspace', '.', '--base-url', base, '--token', 'test', '--json'], { cwd: callerDir, env: { ...process.env, MINNOW_HOME: tempHome, BROWSER: 'none' } })`.
  - Assert the captured `/api/workspace/open` body path equals `fs.realpathSync(callerDir)` and is **not** the Minnow repo root. Ignore the exit code — the run fails later at generations, which is fine; the workspace claim is the observable evidence.
  - Allow a generous timeout (this spawns tsx). Run it directly: `node --import tsx --import ./test/test-loader.mjs --test --test-force-exit test/headless/cli-launcher-cwd.test.mjs`.
- **Accept:** `minnow run --workspace .` launched from an unrelated directory registers that directory with the server, not the Minnow install directory.
- **Touches:** `bin/minnow.mjs`, `test/headless/cli-launcher-cwd.test.mjs`

#### Task W1-D: Test teardown writes the developer's real profile (MIN-47)

- **Build:**
  1. In `server/workspace/root.js`, add an exported sync helper beside `setDefaultWorkspaceRoot` (after line 497):
     ```js
     /**
      * Reset the in-memory process default workspace with no persistence (tests only).
      * `setDefaultWorkspaceRoot` writes config.json + the MRU and may auto-apply a
      * workspace profile, so a test teardown that calls it after restoring the real
      * MINNOW_HOME mutates the developer's installed profile (MIN-47).
      * @param {string} absPath
      */
     export function resetDefaultWorkspaceRootForTests(absPath) { … }
     ```
     It must assign the module-level `workspaceRoot = path.resolve(absPath)` and `workspaceUserChosen = false`, and must not call `readConfigJson`, `writeConfigJson`, `touchRecentWorkspacePath`, `maybeAutoApplyWorkspaceProfile`, or `validateWorkspacePath`. Do not change `setDefaultWorkspaceRoot` or the `setWorkspaceRoot` alias — production callers and the brain index worker still need them.
  2. Replace the teardown call only (leave `before`/`beforeEach` setup on `setWorkspaceRoot`, which legitimately writes into the temp home) in:
     - `test/lsp/workspace-root.test.mjs:67`
     - `test/lsp/vite-config-diagnostics.test.mjs:142`
     - `test/lsp/typescript-lsp.integration.test.mjs:75`
     - `test/lsp/typescript7-diagnostics.test.mjs:45`
     - `test/orchestrator/board-git-ensure.test.mjs:153`
     Each becomes a plain (non-awaited) `resetDefaultWorkspaceRootForTests(PROJECT_ROOT)` / `(APP_ROOT)` / `(previousWorkspace)` call, and each file's import list is updated. Because the helper never touches disk, the teardown order relative to `delete process.env.MINNOW_HOME` stops mattering — but keep `MINNOW_HOME` deletion last anyway.
  3. `test/orchestrator/**` runs on bare `node` (`test/test-config.mjs:102`), so the helper must stay plain JS with JSDoc — no TS syntax.
- **Test:** Create `test/workspace/workspace-root-test-reset.test.js` (matches the `test/workspace/*.test.js` → `tsx-mocks` rule). With `MINNOW_HOME` pointed at a fresh `mkdtemp`: assert `resetDefaultWorkspaceRootForTests(tmpA)` makes `getDefaultWorkspaceRoot()` return `tmpA` and `isWorkspaceUserChosen()` return `false`; assert `path.join(tempHome, 'config.json')` still does not exist afterwards; then call `setWorkspaceRoot(tmpB)` and assert `config.json` **does** exist, proving the two helpers differ. Restore env and remove the temp dirs in `after`. Then run `npm run test:lsp` and `npm run test:orchestrator` and confirm both are as green as they are on `main`.
- **Accept:** With a temp `MINNOW_HOME`, calling `resetDefaultWorkspaceRootForTests` repoints `getDefaultWorkspaceRoot()` while leaving `config.json` absent, and no `test/lsp/**` teardown calls a persistent workspace setter.
- **Touches:** `server/workspace/root.js`, `test/lsp/workspace-root.test.mjs`, `test/lsp/vite-config-diagnostics.test.mjs`, `test/lsp/typescript-lsp.integration.test.mjs`, `test/lsp/typescript7-diagnostics.test.mjs`, `test/orchestrator/board-git-ensure.test.mjs`, `test/workspace/workspace-root-test-reset.test.js`

#### Task W1-E: Scheduler preparation failure leaks a run slot (MIN-57)

- **Build:**
  1. Restructure `runStoredJob` in `server/scheduler/runner.js` so that **everything after admission** is inside one `try`/`finally`. Keep the two early returns (`already_running`, `concurrency_cap`) above `activeJobIds.add(jobId)`; from that line on, wrap the body. Extract the existing child-spawn block (current lines 128-217) into a module-local `async function executeJobRun({ storedJob, runId, baseUrl, timeoutMs, spawnImpl })` returning `{ stdout, stderr, exitCode, timedOut, parsedResult }` so the outer function reads as prepare → execute → settle.
  2. Add two module-local helpers:
     - `async function settleRunFailure(jobId, run)` — best-effort `upsertRun` of a `status: 'failed'` row (id, jobId, startedAt, completedAt, exitCode `1`, `error`), wrapped in its own `try/catch` that `console.warn`s on failure.
     - `async function clearJobRunningFlag(jobId, storedJob, completedAt)` — the `mutateStoredJob` call currently at lines 252-258, wrapped in its own `try/catch` so a history-write rejection can never skip it.
  3. In the `finally`, always run `activeChildren.delete(runId)`, `activeJobIds.delete(jobId)` and `await clearJobRunningFlag(...)`, in that order. The history `upsertRun` for the success path must be `await`ed **before** the flag clear but must not be able to prevent it — put it in its own `try/catch`.
  4. Preparation failures (`decryptSecretPayload`, `resolveJobRunModel`, `resolveJobWorkspacePath`, the initial `upsertRun`) must be caught and converted into the same shape the child-failure path returns: `{ started: true, runId, status: 'failed', exitCode: 1, output: '', error: <message> }`. `runStoredJob` must not reject for a bad job — a uniform resolved result is what makes the dispatcher safe.
  5. In `server/scheduler/tick.js`, wrap the `await runStoredJob(stored, …)` call at line 50 in a per-job `try/catch` that `console.warn`s the job id and continues the loop, so one unexpected throw cannot abandon the remaining due jobs in that tick. Leave the `ticking` guard and the `MAX_CONCURRENT_RUNS` break as they are.
  6. Do not change `MAX_CONCURRENT_RUNS`, `shutdownSchedulerRuns`, or the notification block at lines 260-269 (it must still run for failed preparations — verify `summarizeRunForNotification` tolerates a null `parsedResult`).
- **Test:** Extend `test/scheduler/runner.test.mjs` (it already has a temp-`MINNOW_HOME` harness and a `fakeSpawn` stub) with a preparation-failure case: `createJob(...)`, then overwrite the stored job's `promptEnc` with a plain string via `mutateStoredJob` so `decryptSecretPayload` throws `Value is not an encrypted secret payload`, then call `runStoredJob(stored, { spawn: fakeSpawn })` and assert (a) it resolves with `status: 'failed'` and a non-empty `error`, (b) `getActiveRunCount() === 0`, (c) `(await getStoredJobById(id)).running === false`, (d) `listRunsForJob(id)` contains one `failed` row, and (e) `fakeSpawn` was never called. Keep the existing tests passing. Run `npm run test:scheduler`.
- **Accept:** After a job whose prompt cannot be decrypted, `getActiveRunCount()` is `0` and the stored job's `running` flag is `false`.
- **Touches:** `server/scheduler/runner.js`, `server/scheduler/tick.js`, `test/scheduler/runner.test.mjs`

### Wave 2 — Make MIN-47 unregressable

#### Task W2-A: Runner-wide test-home guard (MIN-47 follow-up)

- **Build:**
  1. In `test/run-all.mjs`, before the first `runBatch`, create one per-run sandbox home (`fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-test-home-'))`) and set `process.env.MINNOW_TEST_HOME` to it so every `spawnSync` child inherits it (`runBatch` at line 120 passes no explicit `env`, so inheritance already works). Remove the directory in a `finally` around the dispatch in `main()` before `process.exit`. Respect an existing `MINNOW_TEST_HOME` value if one is already set.
  2. In `server/config/home.js`, extend `getMinnowHome()`: after the existing `MINNOW_HOME` / `SPEEDCHAT_HOME` override check (lines 28-34) and **before** the `os.homedir()` fallback (line 36), honour `process.env.MINNOW_TEST_HOME` — resolve and return it, and `console.warn` once per process naming the guard so a fixture that dropped its own `MINNOW_HOME` is visible in the log. Redirect rather than throw: a throw would convert every fixture that deletes `MINNOW_HOME` mid-run into a hard failure, and the goal is that the real profile becomes unreachable, not that the suite breaks. `resetMinnowHomeCache()` must keep working (the guard is read through the same cached path).
  3. Leave the legacy `~/.speedchat` rename branch (lines 36-45) unreachable under the guard — it must not run against the sandbox.
  4. Known limitation to note in the commit body: `src/headless/server-context.ts:17` and `server/mcp-hub/stdio.js:29` resolve the home independently and are not covered by this guard.
- **Test:** Create `test/config/minnow-home-test-guard.test.js` (`test/config/*.test.js` → `tsx-mocks`): save and clear `MINNOW_HOME`/`SPEEDCHAT_HOME`, set `MINNOW_TEST_HOME` to a temp dir, `resetMinnowHomeCache()`, and assert `getMinnowHome()` returns that dir and **not** `path.join(os.homedir(), '.minnow')`; assert an explicit `MINNOW_HOME` still wins over the guard; restore all env vars and reset the cache in `after`. Then run the **full** `npm test` — this changes a path every suite depends on, so a scoped run is not sufficient evidence.
- **Accept:** With `MINNOW_TEST_HOME` set and `MINNOW_HOME` deleted, `getMinnowHome()` returns the sandbox path, and `npm test` is no worse than the pre-change baseline on `main`.
- **Touches:** `server/config/home.js`, `test/run-all.mjs`, `test/config/minnow-home-test-guard.test.js`
- **Depends on:** W1-D

## Verification Checklist

- [ ] `npx tsc --noEmit` passes
- [ ] `npm run test:check-coverage` passes (three new test files must each resolve to a runner)
- [ ] `npm run test:onboarding` passes (W1-A)
- [ ] `npm run test:product-wiki` passes (W1-B)
- [ ] `node --import tsx --import ./test/test-loader.mjs --test --test-force-exit test/headless/cli-launcher-cwd.test.mjs` passes (W1-C)
- [ ] `npm run test:lsp` and `npm run test:orchestrator` are no worse than the `main` baseline (W1-D)
- [ ] `npm run test:scheduler` passes (W1-E)
- [ ] `npm test` is no worse than the `main` baseline (W2-A — required, not optional)
- [ ] `git status` shows no changes under `dist/`, `dist-electron/`, `release/`, or `test/fixtures/`

## Notes for Build Agents

- **One commit per task.** These are four unrelated issues; a mixed commit makes any of them hard to revert. Reference the issue id in the subject (e.g. `MIN-61: probe Ollama at /v1/models, not /v1/v1/models`).
- **Capture the baseline first.** `npm test` does not run fully green on `main` (see `AGENTS.md` → Cursor Cloud notes: in-code default/fixture drift). Record the failing set before you change anything, and compare against it — do not claim a green suite you did not see.
- **Windows shell.** The working tree is on Win32: no Unix `grep`/`tail`/`sed` pipes in `execute_command`; use the grep tool or native commands. Direct `node --test` invocations need `--test-force-exit`.
- **Test harness facts** (`test/test-config.mjs`): new `*.test.mjs` files default to the `tsx-mocks-loader` runner, `test/orchestrator/**/*.test.mjs` and `test/runner/**` run on bare `node`, `test/workspace/*.test.js` and `test/config/*.test.js` run on `tsx-mocks`. Coverage (`test:check-coverage`) only requires a resolvable runner, not suite membership — `test/headless/**` is intentionally outside every scoped suite and runs only in the full sweep.
- **W1-D constraint:** `server/workspace/root.js` is loaded by bare-`node` suites, so the new helper stays plain JS with JSDoc types.
- **W1-E contract:** `runStoredJob` resolving (never rejecting) for a bad job is the point of the fix — the `tick.js` `try/catch` is defence in depth, not the primary mechanism. Do not "simplify" by letting preparation errors propagate.
- **Scope discipline:** MIN-63 (move headless/Scheduler onto the shared turn runner) and MIN-56 (jobs stuck `running` after restart) are adjacent but separate cards — do not fold them in. MIN-48 (packaged Electron LAN binding) is explicitly blocked on MIN-44 and is not in this plan.
- **MIN-47's CI isolation check** (the review also asks for a CI-level user-state assertion) is deliberately deferred: W2-A's guard makes the real profile unreachable during `npm test`, which is the load-bearing half. File a follow-up if you want the workflow gate too.
