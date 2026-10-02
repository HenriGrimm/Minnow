---
name: min-108-git-history-2d-map
overview: Replace Source Control's row-based history graph with a production-ready, accessible 2D commit DAG covering local and remote refs, progressive history expansion, Code Map-style navigation and discovery controls, and the existing commit diff review experience fixed on the left.
todos:
  - id: W1-A
    content: "Wave 1: Add progressive all-ref history data contract"
    status: pending
  - id: W1-B
    content: "Wave 1: Extract reusable spatial viewport behavior"
    status: pending
  - id: W2-A
    content: "Wave 2: Build deterministic commit-map model and layout"
    status: pending
  - id: W2-B
    content: "Wave 2: Build accessible commit-map scene and controls"
    status: pending
  - id: W3-A
    content: "Wave 3: Integrate the map with left-side commit diff review"
    status: pending
  - id: W4-A
    content: "Wave 4: Harden responsive, accessibility, and performance behavior"
    status: pending
isProject: true
---

# MIN-108 — 2D Git History Map

**Date:** 2026-10-01
**Goal:** Replace Source Control's list history with a production-ready spatial branch/commit map that makes commit discovery and diff review fast across all local and remote refs.
**Granularity:** medium

## Context

MIN-108 asks for the Source Control History section to adopt the interaction pattern and visual language of Code Map. Today, `createHistoryView()` mounts `renderGitGraph()`, which fetches at most 200 commits from every ref and paints a vertically scrolling row list. Selecting a row already loads `gitShow()` and renders per-file diffs, but that detail is currently on the right.

The agreed scope is a full replacement, not a Map/List toggle or MVP. It must include all local and remote refs, deterministic chronological lanes with crossings minimized, pan/zoom, fit/reset, a minimap, keyboard navigation, search/filter, branch collapsing, and progressive bounded history windows with explicit expansion. Commit review remains the primary outcome. The diff panel moves to the left, and narrow layouts preserve the Source Control center's existing responsive split behavior.

No new third-party dependency is required: the repository already has a DOM/SVG Code Map viewport and scene conventions. Reuse/refactor those primitives instead of introducing another graph library. The current backend already invokes `git log --topo-order --all --exclude=refs/stash`; the missing pieces are continuation metadata and stable incremental retrieval.

## Architecture / Key Files

| File | Role | Action |
|------|------|--------|
| `server/git/git-ops.js` | Executes and parses all-ref Git history | MODIFY |
| `server/git/middleware.js` | Dispatches `/api/git` operations | VERIFY |
| `src/state/git-api.ts` | Typed renderer contract for Git operations | MODIFY |
| `src/ui/code-map/viewport.ts` | Existing pan/zoom, fit, reveal, keyboard, and minimap behavior | MODIFY |
| `src/ui/git-history-map/model.ts` | Commit/ref filtering and collapse model | CREATE |
| `src/ui/git-history-map/layout.ts` | Deterministic DAG lane placement and SVG edge routes | CREATE |
| `src/ui/git-history-map/scene.ts` | Accessible spatial commit cards, ref chips, and edges | CREATE |
| `src/ui/git-history-map/page.ts` | Map controller, toolbar, search, pagination, selection, and lifecycle | CREATE |
| `src/ui/git-graph-context-menu.ts` | Existing commit actions invoked from map nodes | VERIFY |
| `src/ui/scc-history.ts` | History split view and commit detail integration | MODIFY |
| `src/styles/source-control-center.css` | Source Control split/detail/responsive layout | MODIFY |
| `src/styles/git-panel.css` | Existing Git graph tokens and context-menu styling | MODIFY |
| `src/styles/code-map.css` | Reference visual language; shared viewport selectors may be generalized | MODIFY |
| `src/styles/mobile.css` | Narrow Source Control behavior | MODIFY |
| `test/server/git-log-parse.test.mjs` | Git log parser and history contract coverage | MODIFY |
| `test/ui/git-history-map.test.mts` | Model/layout/controller unit and DOM coverage | CREATE |
| `test/ui/scc-history-click.test.mts` | End-to-end History selection/diff behavior | MODIFY |
| `test/ui/scc-history.test.mts` | Commit detail parsing coverage | MODIFY |

## Wave Breakdown

### Wave 1 — Foundations

Tasks here run concurrently.

#### Task W1-A: Add progressive all-ref history data contract
- **Build:** In `server/git/git-ops.js`, extend `log({ cwd, count, skip })` (or an equivalently named cursor input) so `git log --topo-order --all --exclude=refs/stash` returns bounded windows plus `hasMore` and `nextSkip`; request one sentinel record beyond the page size, clamp page size/offset defensively, and preserve `parseLogLine()` output. In `src/state/git-api.ts`, add `GitLogResult`, pagination fields on `GitOpResult`, and `skip` to `gitLog()`. Keep `server/git/middleware.js` dispatch compatible and do not expose arbitrary Git arguments. Expected scope: roughly 60–100 lines across the server/client contract and tests.
- **Test:** Extend `test/server/git-log-parse.test.mjs` with parser fixtures for local refs, `remotes/<remote>/...`, tags, merge parents, and empty decorations. Add a focused test around the exported history paging helper/operation proving the sentinel is removed, `hasMore`/`nextSkip` are correct, invalid values clamp safely, and the generated request retains `--all`, `--topo-order`, and stash exclusion. Run `node --test test/server/git-log-parse.test.mjs --test-force-exit`.
- **Accept:** Two consecutive `gitLog({ count, skip })` requests return non-overlapping, topologically ordered commit windows and an explicit truthful continuation indicator while retaining decorators for all refs.
- **Touches:** `server/git/git-ops.js`, `server/git/middleware.js`, `src/state/git-api.ts`, `test/server/git-log-parse.test.mjs`

#### Task W1-B: Extract reusable spatial viewport behavior
- **Build:** Generalize `createViewport()`, `ViewportApi`, `ViewState`, and `MinimapShape` from `src/ui/code-map/viewport.ts` into `src/ui/spatial-viewport.ts`; make the CSS custom-property prefix configurable or neutral so Code Map retains `--code-map-zoom` while Git History can use its own token. Update Code Map's `ensureViewport()` import/use without changing its behavior. Preserve drag suppression, pointer capture cleanup, wheel/trackpad behavior, `fit()`, `reveal()`, keyboard pan/zoom, minimap drag, resize handling, and `destroy()`. Expected scope: one extracted module plus small import/style updates, roughly 80–140 changed lines.
- **Test:** Create `test/ui/spatial-viewport.test.mts` using happy-dom to assert keyboard `+/-/0`, arrow panning, fit/reveal state, drag-click suppression, and listener/ResizeObserver teardown; keep existing Code Map tests green. Run `node --import tsx --import ./test/test-loader.mjs --test test/ui/spatial-viewport.test.mts --test-force-exit`.
- **Accept:** Code Map behaves unchanged using the shared viewport, and a second consumer can independently pan, zoom, fit, reveal, and render a minimap without Code Map-specific DOM ids.
- **Touches:** `src/ui/code-map/viewport.ts`, `src/ui/spatial-viewport.ts`, `src/ui/code-map/page.ts`, `src/styles/code-map.css`, `test/ui/spatial-viewport.test.mts`

### Wave 2 — Commit Map

#### Task W2-A: Build deterministic commit-map model and layout
- **Build:** Create `src/ui/git-history-map/model.ts` with exact types `GitHistoryNode`, `GitHistoryEdge`, `GitHistoryRef`, `GitHistoryFilter`, and functions `buildGitHistoryModel()`, `filterGitHistoryModel()`, and `collapseGitHistoryBranches()`. Create `src/ui/git-history-map/layout.ts` with `GitHistoryLayout`, `GitHistoryBox`, `layoutGitHistory()`, and `routeGitHistoryEdges()`. Base parent edges strictly on `GitCommitEntry.parents`; classify HEAD/local/remote/tag decorations without assuming only `origin`; order generations chronologically/topologically, give lane identity stable deterministic tie-breakers, keep the first-parent/trunk flow prominent, minimize crossings, and retain boundary stubs when a parent is outside the loaded window. Collapse only presentation groups, never delete the selected node or ref tips. Expected scope: two modules totaling roughly 350–550 lines.
- **Test:** Add pure tests in `test/ui/git-history-map.test.mts` covering linear, fork, merge, octopus merge, multiple remotes, tags, detached HEAD, orphan histories, missing boundary parents, stable output after appending an older page, crossing minimization invariants, filter context preservation, and collapse/expand retaining selected/ref-tip nodes. Run `node --import tsx --import ./test/test-loader.mjs --test test/ui/git-history-map.test.mts --test-force-exit`.
- **Accept:** The same commit/ref input always produces the same non-overlapping node coordinates and parent-edge paths, and appending older commits does not move the already-rendered newer window.
- **Touches:** `src/ui/git-history-map/model.ts`, `src/ui/git-history-map/layout.ts`, `test/ui/git-history-map.test.mts`
- **Depends on:** W1-A

#### Task W2-B: Build accessible commit-map scene and controls
- **Build:** Create `src/ui/git-history-map/scene.ts` with `renderGitHistoryScene()`, `GitHistorySceneApi.setSelection()`, `GitHistorySceneApi.setFocus()`, and `GitHistorySceneApi.nodeElement()`; render parent links in SVG and commits as native buttons with subject, author/time, short SHA, HEAD/local/remote/tag chips, selected/focused states, and context-menu callbacks compatible with `showGitGraphCommitContextMenu()`. Create `src/ui/git-history-map/page.ts` with `createGitHistoryMap()` and `GitHistoryMapHandle`; add debounced search across loaded subjects/authors/SHAs/refs, ref-type filters, branch collapse/expand controls, zoom in/out, fit/reset, minimap, Load older, refresh/error/empty states, roving keyboard focus (arrow keys follow spatial neighbors; Home focuses HEAD; Enter/Space selects), and live status text. Use Flaticon UIcons through existing project helpers for interface icons; do not use emoji/glyph icons. Expected scope: two modules totaling roughly 500–750 lines.
- **Test:** Extend `test/ui/git-history-map.test.mts` under happy-dom to assert semantic button/toolbar roles, accessible labels, roving tabindex, directional focus, Home/Enter/Space behavior, search and filter context, collapse/expand, context-menu callback, selected state, Load older append/deduplication, stale-request suppression, errors/retry, minimap shapes, and destroy cleanup. Run the focused TS test command and `npm run check:icons`.
- **Accept:** A keyboard-only user can find any loaded commit/ref, navigate and select it, expand collapsed branches or older history, and operate fit/zoom controls while screen-reader state reports selection and result counts.
- **Touches:** `src/ui/git-history-map/scene.ts`, `src/ui/git-history-map/page.ts`, `test/ui/git-history-map.test.mts`
- **Depends on:** W1-A, W1-B, W2-A

### Wave 3 — Source Control Integration

#### Task W3-A: Integrate the map with left-side commit diff review
- **Build:** In `src/ui/scc-history.ts`, replace `renderGitGraph()`/`GitGraphOptions` with `createGitHistoryMap()`/`GitHistoryMapHandle`; reorder the split so `detailCol` is first/left and the map fills the right, while keeping `selectCommit()`, `renderDetail()`, `buildFileRow()`, retry logic, and `showGitGraphCommitContextMenu()` behavior. Keep selection painting local instead of re-fetching/rebuilding history, preserve selected commit across ordinary refresh when still present, abort/ignore stale `gitShow()` results, and reset selection on workspace change. Update `src/styles/source-control-center.css`, `src/styles/git-panel.css`, and `src/styles/mobile.css` so the diff column uses the current review width, the map owns remaining space, controls/minimap do not cover nodes, theme/reduced-motion/high-contrast tokens are respected, and the existing narrow breakpoint stacks detail and map consistently. Remove obsolete row-list render code/styles from `src/ui/git-graph.ts` only after confirming no other caller; retain reusable ref parsing/context-menu types in a narrowly named module if needed. Expected scope: roughly 250–400 integration/style lines plus deletion of the superseded list renderer.
- **Test:** Update `test/ui/scc-history-click.test.mts` selectors and assertions to prove commit selection stays in Source Control, the first file diff opens on the left, retry works, rapid A→B selection cannot paint A's late response, context actions still receive the selected commit, and destroy cancels map/detail behavior. Update `test/ui/scc-history.test.mts` for empty/merge/binary commit detail cases. Run both focused tests and `npx tsc --noEmit`.
- **Accept:** Opening Source Control → History shows a spatial map on the right; selecting any commit opens its files and first diff in the left review panel without navigation or a history reload.
- **Touches:** `src/ui/scc-history.ts`, `src/ui/git-graph.ts`, `src/ui/git-graph-context-menu.ts`, `src/styles/source-control-center.css`, `src/styles/git-panel.css`, `src/styles/mobile.css`, `test/ui/scc-history-click.test.mts`, `test/ui/scc-history.test.mts`
- **Depends on:** W2-B

### Wave 4 — Production Hardening

#### Task W4-A: Harden responsive, accessibility, and performance behavior
- **Build:** Exercise `createGitHistoryMap()` against large synthetic DAGs and refine its exact functions `appendPage()`, `applyFilter()`, `renderVisibleScene()`, and `destroy()` so page append is incremental, duplicate hashes are removed, already-laid-out nodes remain stable, offscreen work is bounded/chunked, and ResizeObserver/requestAnimationFrame/search timers are canceled. Add focus restoration after filter/collapse/refresh, `prefers-reduced-motion` behavior, forced-colors-visible edges/focus rings, narrow split overflow protection, and zero-state/error copy consistent with Source Control conventions. Update `documentation/context.md` to replace its list-history description with the shipped 2D map, pagination, interaction, and diff-panel behavior. Expected scope: roughly 150–250 implementation/test/doc lines.
- **Test:** Add a 5,000-node synthetic fixture to `test/ui/git-history-map.test.mts` asserting deterministic layout, bounded initial DOM nodes, progressive expansion, no duplicates, selection/focus preservation, and cleanup; use objective elapsed-time assertions only if the repo has an established stable threshold, otherwise assert bounded work/DOM counts. Run `npm run test:check-coverage`, `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run check:performance-budgets`, and `npm run impeccable:detect`. In a running Electron build, verify mouse pan/zoom, trackpad pan/pinch, minimap drag, fit/reset, keyboard traversal/selection, search/filter/collapse, Load older, context actions, diff-on-left, resize at the existing Source Control breakpoint, light/dark themes, reduced motion, and forced colors.
- **Accept:** A repository with at least 5,000 reachable commits remains responsive through initial render, filtering, selection, and progressive expansion, with no clipped controls, lost focus, or unreadable topology at supported window sizes/themes.
- **Touches:** `src/ui/git-history-map/**`, `src/ui/scc-history.ts`, `src/styles/source-control-center.css`, `src/styles/git-panel.css`, `src/styles/mobile.css`, `test/ui/git-history-map.test.mts`, `test/ui/scc-history-click.test.mts`, `documentation/context.md`
- **Depends on:** W3-A

## Verification Checklist

- [ ] `node --test test/server/git-log-parse.test.mjs --test-force-exit` passes.
- [ ] Focused happy-dom tests for `spatial-viewport`, `git-history-map`, and `scc-history` pass.
- [ ] `npm run test:check-coverage` reports every new test file as discovered.
- [ ] `npx tsc --noEmit` passes.
- [ ] `npm test` passes, with any pre-existing baseline failures identified separately.
- [ ] `npm run build` passes.
- [ ] `npm run check:icons` passes.
- [ ] `npm run check:performance-budgets` passes without raising a budget.
- [ ] `npm run impeccable:detect` passes.
- [ ] Electron manual acceptance covers mouse, trackpad, keyboard, minimap, search/filter, collapse, progressive history, context actions, left-side diff, responsive layout, themes, reduced motion, and forced colors.

## Notes for Build Agents

- The current `git log` path already includes every ref via `--all`, excludes stash refs, uses `--topo-order`, and caps output at 200. Extend that contract rather than inventing a separate history endpoint.
- Do not infer topology from branch labels or squash-merge subjects. Parent hashes are authoritative; decorators are labels/ref tips. Preserve missing-parent boundary edges until an older page supplies the node.
- Prefer stable append-only geometry over globally tighter re-layout: progressive loading must not make the user's selected commit jump.
- Treat `src/ui/code-map/*` as interaction/visual reference, not as Git domain code. Only the neutral viewport primitive should be shared; Git model/layout/scene semantics stay isolated.
- Keep the existing `gitShow()` commit-detail renderer and `showGitGraphCommitContextMenu()` actions unless a tested extraction is necessary.
- All interface icons must come from `@flaticon/flaticon-uicons` through existing icon conventions. Use text only where an icon adds no value; do not use emoji or Unicode glyphs as icons.
- Application colors belong in existing `--mn-*` or Git lane tokens; do not introduce raw hex/rgba values outside `src/styles/tokens.css`.
- The full suite may have unrelated baseline failures. Builders must report them distinctly and still prove all focused MIN-108 checks.
