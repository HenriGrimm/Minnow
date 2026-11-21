# Minnow cleanup audit — 2026-11-20

Baseline: `5ccb316bc`, with the benchmark-dataset gitlink cleanup already staged. This is a repo-wide **source and Git inventory**, not a line-by-line code review, runtime trace, or inventory of users' saved data. Product decisions below are recorded from the follow-up; implementation and deletion of local data are not part of this audit.

## P0 — Repository hygiene

| Candidate | Evidence | Cleanup |
|---|---|---|
| Tracked compiler caches | `tsx-Henri/`: 1,338 files / 25.4 MB; `node-compile-cache/`: 398 files / 1.1 MB. Tracked on the audited baseline, not just local cache folders. | Untrack and ignore narrowly; keep local copies if useful. Ensure the actual cache locations are outside the checkout or ignored. |
| Tracked print/PDF work | `output/pdf/` (5 files / 22.4 MB) and `tmp/pdfs/` (20 files / 7.9 MB) contain print proofs, fonts and authoring scripts for unrelated work. Counts are checkout sizes, not Git object or installer sizes. | Preserve or relocate the deliverables and source before untracking. Ignore the specific paths; don't rewrite Git history as part of normal cleanup. |
| Accidental test homes | Two repo-root `minnow-issues-backup-*` folders, 53 tracked files each. `test/issues/schema-forward-compat.test.mts:227` creates a temp directory with that prefix. Filename convention is evidence, not proof of which invocation left the copies. | Untrack and ignore narrowly. Check the temp-root and teardown behavior before changing the test. Use an explicit known fixture if any of these files turns out to be required. Don't paste contents into logs or tickets. |
| Benchmark dataset gitlinks | Three pointers without `.gitmodules` were already staged for removal; the clones are preserved under `.minnow/eval-datasets/`. | Keep separate from the product Benchmarking decision. Local Harbor virtualenv is not tracked; remove it only if no longer wanted. |

The first three rows account for **1,867 tracked paths and 56.8 MB** of checked-out content. This is not a claim about how much historical Git storage will shrink.

## P1 — Retired or redundant code with narrow removal paths

| Candidate | Verified evidence | Scope / guardrail |
|---|---|---|
| Board V1 seed and log checker stubs | `scripts/check-board-log.mjs:17` prints retirement help and exits nonzero; `package.json:49` still exposes it; `server/orchestrate/board-testing/middleware.js:212` serves only HTTP 410 for `seed` and `check-log`. | Remove the npm alias and stub; remove the 410 tombstones only when willing to drop their redirect guidance. Update the dev UI copy, tests and contributor docs. Keep Boards V2, scenario contract, fake model and journal tooling. |
| Board V1 JSONL mirror | `server/orchestrate/middleware.js:24` still accepts legacy reads/writes; scoped Git search found no tracked in-tree producer other than the API tests. The tail API still reads existing logs (`server/orchestrate/board-testing/middleware.js:228`). | Separate the redundant writer from the read-only diagnostic tail; announce the API removal or keep a short tombstone if external callers need notice. Keep historical files and the V2 journal. Do not delete the entire `server/orchestrate/` tree. |
| Sub-agent controller stubs | `src/agents/orchestrator.ts:891` and `:924`: empty recorder/fingerprint and immediate-resolve init/readiness exports; no callers found in tracked source, tests or scripts. | Remove the four stubs. Keep journal hydration, SSE, delegation, cancellation and reset paths. Audit `checkInNudgeMs` separately across config serialization, not just the renderer type. |
| Mode-based tool gating | `src/chat/modes/tool-policy.ts:14` passes the catalog through; `:18` always returns true. Live callers in `src/tools/client.ts`, `src/headless/chat-preparation.ts` and `src/headless/execute-tool.ts`; `src/chat/prompts/modes/_template/MODE_TEMPLATE.md:41` still describes enforcement that no longer exists. | Remove pass-through branches and unused metadata after tracing readers. Preserve profile allowlists, permissions, skill clamps, tool availability, and persisted mode normalization. |
| Superseded automatic memory synthesis | `server/brain/synthesis.js:524` still has the old memory-proposal writer; no production consumers found. `server/brain/synthesis-routes.js:160` runs skill synthesis and `:172` reports memory as retired. | Remove the uncalled writer and writer-only helpers after tracing shared exports. Keep skill synthesis, legacy page management, and response compatibility where still consumed. |
| Obsolete documentation and catalog copy | The mode template still advertises old gating; the Board Testing UI says the npm script returns HTTP 410 (it actually exits 1); Advanced Settings copy still advertises Capability Matrix even though direct navigation redirects to Diagnostics. | Fix copy in the matching cleanup change. Keep historical release notes and useful redirects; don't erase migration rationale. |

## P2 — Confirmed sunsets and what stays

`src/os/app-registry.ts:49–86` gates the four apps. `documentation/ROADMAP.md:29` still describes them and Super Plan as gated rather than cancelled; update this with the removals. Most of their API middleware still mounts in production (`server/runtime/middlewares.js:211–224`, `:262–264`). No external HTTP clients or local installed users were inventoried.

| Decision | Evidence and separation boundary |
|---|---|
| **Research — remove** | Remove the standalone UI, API, settings, Brain capture integration and Research-specific storage support; no library data migration or export is required. Extract shared search configuration and LLM/JSON helpers used by Brain, skills and normal web search before removing the feature. Coordinate with Super Plan, which imports the Research store. |
| **Compare — remove** | Remove blind A/B UI, mounted API and Compare-specific history/vote support. Keep generic model selection and usage history. Check old backup compatibility without retaining the live Compare writer. |
| **Benchmarking — remove the app; keep Capability Matrix internal** | Preserve the matrix's campaigns, fixtures, XLSX import/export and only the API/storage/data it uses. Remove app-only suites and benchmark packs after tracing consumers. Keep live Models provider/tool capability probes separate. Matrix Settings search is already filtered and old section routes go to Diagnostics (`src/ui/settings-catalog-filter.ts:12`, `src/ui/settings-section-navigation.ts:34`); keep the retained harness off the public rail. |
| **Experts and Evals — remove; preserve chats and results** | Remove execution/UI and Evals-specific endpoints, tests and packs. Preserve expert transcripts and existing eval results in a readable or exportable form; verify old-session hydration (`src/state/session-schema.mjs:194,1267`). Remove Experts teardown imports from live app pages. Keep Agent Packs, which has its own live Settings section (`src/ui/settings-catalog.ts:57`), registry and backup paths. |
| **Super Plan — remove fully** | Remove UI, mode implementation, API, boot recovery, and its private stage engine (`src/config/super-plan-enabled.ts:13`, `server/runtime/middlewares.js:124,220`). Ensure old journals no longer resume and historical mode IDs still open as Plan. Keep `/plan`, plan validation, Boards and user-authored plan files. |
| **Brain legacy wiki — remove; offer cleanup on first launch after upgrade** | Remove legacy wiki editing, ingest, Graph and wiki-specific automation. Show a one-time notice introducing the new Brain system and recommending **Clean up old Brain data**, with **Skip**. The cleanup action deletes only legacy wiki data after explicit confirmation; Skip leaves it on disk. Keep scoped Memories, code indexing and any shared skill-synthesis dependencies. See upgrade checks below. |
| **Board Testing Settings panel — remove** | Remove the hidden Settings panel and its frontend-only wiring. Preserve the fake model, scenario-contract tooling, and CI coverage that use the server harness. |

For an approved sunset: verify UI/routes/tools/settings, boot and shutdown behavior, cross-feature imports, persisted state and backup/restore, then remove dedicated tests/assets/dependencies. Keep one regression for redirects/old data where that compatibility remains useful.

### Brain upgrade and cleanup checks

- On the first launch after upgrade, explain that the new Brain uses scoped Memories, that old wiki data is no longer used by agents, and exactly what cleaning it up deletes. Do not delete anything merely by showing the notice. A fresh install with no legacy data does not need the cleanup prompt.
- Use a versioned acknowledgement for **Skip** or successful cleanup. Keep Skip non-destructive; a failed cleanup must show a retryable error, not mark the migration complete. The cleanup must be safe to retry and authorized on the local host.
- Inventory mixed Brain paths before implementing deletion. Remove legacy wiki pages and their legacy-only sources, indexes and proposals from the active profile, but never delete the entire `brain/` directory: `server/backup/catalog.js:116–117` distinguishes Brain from current memory and explicitly excludes the code index from Brain backups. Preserve current Memories, the code index, separate skill proposals, original chats and existing backup files.
- Verify upgraded profiles with both legacy and current data, Skip followed by restart, successful cleanup followed by restart, partial failure/retry, and restore of a pre-upgrade backup without restoring the retired wiki runtime.

Internal matrix: launch a development build with `MINNOW_DEBUG=1` and open Settings → Advanced → Capability matrix (or `#/app/settings/capability-matrix`). Earlier evaluation results remain readable as JSON in `~/.minnow/evals/runs/` and via authenticated local GET routes under `/api/evals/runs`.

## P3 — Compatibility to migrate, not delete as dead code

- **Renderer execution.** Default server-owned chat is a replacement only for eligible roots. `server/chats/ordinary-routing.js:2–11` excludes specialized chats, old pending work/recovery, historical compaction/forks and other existing cases. Migrate each retained case or explicitly choose a read-only policy before removing the old writer. The CLI already imports the shared turn adapter (`src/headless/runner.ts:51`); older reviews claiming it still needs its own loop replaced are stale.
- **JSON sessions.** `MINNOW_SESSIONS_STORE=json` still selects an actual runtime path (`server/config/sessions-repo.js:1850`); it's separate from the one-time legacy JSON import into SQLite. Decide support for the runtime override, then test upgrades/import, backups, and rollback independently.
- **Native CLI transports.** `server/generations/agent-cli/pump.js:55–65` retains real Codex exec and Claude print selection, not just old env parsing. Phase out only after setting a support floor and validating unbound utility runs, checkpoint/resume, images, cancellation and recorded-tool recovery. Treat as rollback policy, not the hidden-app deletion batch.
- **Old Bug Board.** No `bug_*` entries found in the current server catalog, but the old commands still have a renderer dispatch (`src/tools/client.ts:405`) and legacy issue import runs at startup (`src/main.ts:327–329`). Retire the unadvertised dispatcher separately from reading/migrating old bug data and resolving old IDs.
- **Historical IDs and routes.** Email, Calendar, standalone Desktop, wallpaper and Reef were handled in the earlier cleanup (`documentation/archive/repo-dead-code-cleanup.md:3–21`). Keep cheap old-data normalization and historical usage decoding; don't confuse standalone Desktop with the active Electron shell or the old Chat route alias with the current Code chat.

## Suggested sequence and verification

1. Land repository hygiene separately and check staged path counts, ignore rules, and a fresh workspace repo scan.
2. Remove confirmed narrow remnants; run typecheck and affected board, runner/headless, and memory/Brain tests. Keep existing test harnesses commissioned to exercise live code.
3. Land Super Plan before deleting the Research store; separate retained Matrix code before removing Benchmarking; preserve expert history and eval results before removing their runtimes. Handle the legacy Brain removal and upgrade notice together. Verify API/loader/boot behavior, upgrade fixtures, saved-data handling, and a packaged desktop smoke test. Measure shipped assets after changes; don't equate tracked-pack size with installer savings.
4. Retire compatibility paths only after corresponding replacements or read-only migration policies are verified.

Audit checks: tracked-file inventory and checkout sizes, source/reference searches, API and route registration, migration/docs/test review, and staged diff whitespace check. No runtime suites or packaging runs were performed for this report.
