# Repo dead-code cleanup — Email, Calendar, Desktop, Wallpaper, Reef

**Status:** Shipped — archived (MIN-127) · Implementation complete in worktree `orchestrator-v2-a8c3f1e4` · **Date:** 2026-09-02

Five cancelled features — Email, Calendar, Desktop, Wallpapers, Reef — left product code, deps, and tracked junk. Wallpapers and Reef were mostly deleted already; Calendar and Email have been removed; Desktop was remapped rather than removed.

Each phase must end green on `npx tsc --noEmit` and `npm test`.

Do **not** touch Electron desktop-shell code: tray, zoom, launch-at-startup (`src/ui/settings-desktop-shell.ts`, `electron/desktop-shell-config.ts`, `electron/tray*.ts`, `electron/shell-zoom.ts`).

---

## Todos

- [x] Phase 1 — Repo hygiene (tracked junk, impeccable dup, wallpaper extract, gitignore)
- [x] Phase 6 — Unreferenced scripts + modules; archive shipped plans
- [x] Phase 5 — Reef remnants (keep enum fallback; drop live-write)
- [x] Phase 2 — Desktop remnants (keep `normalizeModeId` remap)
- [x] Phase 3 — Calendar app + server + tools + `node-ical` / `rrule` / `tsdav`
- [x] Phase 4 — Email app + server + tools + `imapflow` / `mailparser` / `nodemailer` + `appScope` migration
- [x] Docs — `context.md` and contributor/manual pages listed below
- [x] Verify — `npx tsc --noEmit` green; cleanup-related suites green; full `npm test` still has pre-existing/env failures (no Electron dist in this worktree, Windows symlink EPERM, node_modules junction path)

---

## Phase 1 — Repo hygiene (zero product code)

`server/session/engine-bundle/` is **already deleted** on this HEAD (MIN-717 / P4-E). Skip.

- Tracked root junk: `.ci-gh-watch.log`, `.ci-windows.log`, `test-run-output.txt`, `debug.log`, `test-output.txt`, `untitled.txt`, `.DS_Store`. Delete + gitignore.
- Untrack + gitignore local scratch: `.impeccable/critique/*.md`, `.impeccable/live/**`, `.minnow/design/annotations.json`, `.cursor/plans/*.plan.md`. Keep `.impeccable/design.json`.
- `.agents/skills/impeccable/` — duplicate of `src/skills/impeccable/`. Delete from git; gitignore so `impeccable:sync` / `npx impeccable skills install` can recreate it locally without re-committing. Keep `UPSTREAM_SCRIPTS_PREFIX` in `scripts/impeccable-preserves/apply-minnow-patches.mjs` (it rewrites that prefix to `src/skills/impeccable/scripts/`).
- `documentation/extracts/underwater-wallpaper/` — last wallpaper extract. Update `documentation/README.md` extracts bullet if the folder is empty.

## Phase 2 — Desktop

Keep `'desktop' → 'general'` in `normalizeModeId`. Delete unreachable mode prompts, `MODE_DEFINITIONS.desktop`, `MODE_ALLOWED_GROUPS.desktop`, `modeId === 'desktop'` branches, no-op shims, unused `desktopLayout` pref, `src/lib/desktop-workspace.ts` + `server/desktop-workspace/` + middleware. Inline live callers of `src/os/desktop-chat.ts` into `chat-launch.ts` then delete the file.

Tests: `test/lib/desktop-workspace.test.mts`, `test/chat/streaming-state-desktop.test.mts`, `test/helpers/legacy-desktop-state.ts`.

## Phase 3 — Calendar

Remove hidden Calendar app (client, server, tools, onboarding, tests, npm script, deps `node-ical`, `rrule`, `tsdav`).

## Phase 4 — Email

Same recipe at larger scale. Normalize persisted `Chat.appScope === 'email'` to `null` before the `AppId` union narrows.

## Phase 5 — Reef remnants

Keep `{ kind: 'reef-widget' }` on the usage enum for historical rows; drop live-write path; fix `scripts/fix-theme-color-mix.mjs` dead path.

## Phase 6 — Other stale

Audit then delete unreferenced scripts (17 listed in the spec). Delete unreferenced modules. Move shipped `documentation/plans/` one-offs to `documentation/archive/`; keep live plans (`orchestrator-v2*.md`, this file). Drop `documentation/archive/_extracted-app.js` and `_extracted-body.html`.

## Docs to update (phases 3–4, plus hygiene)

`documentation/context.md`, `contributor/apps-and-routes.md`, `contributor/architecture.md`, `contributor/commands.md`, `contributor/setup-from-source.md`, `design-system/css-map.md`, `design-system/primitives.md`, `guides/release-e2e-testing.md`, `maintainer/settings-reference.md`, `manual/apps/brain.md`, `ROADMAP.md`, `AGENTS.md` if counts change.
