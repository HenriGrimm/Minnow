---
name: fix-run-impeccable-detect-timeout
overview: Design pass (run_impeccable detect) timed out because omitted target scanned the whole workspace under a 60s kill. Default to UI source paths, treat findings exit 2 as success, and force-kill hung children.
todos:
  - id: default-targets
    content: Replace detect default `.` with UI/source path resolution; multi-arg CLI; reject URLs; pass --json
    status: completed
  - id: timeout-hygiene
    content: SIGKILL/taskkill after SIGTERM; timeout message includes actual targets and narrower-target hint
    status: completed
  - id: exit-code-2
    content: Treat impeccable detect exit 2 as findings, not a tool error
    status: completed
  - id: tests
    content: Update test/impeccable/run-impeccable.test.mjs for defaults, no-hang, URL reject, exit 2
    status: completed
  - id: docs
    content: Update tool schema, SKILL.md, documentation/context.md, and this plan
    status: completed
isProject: true
---

# Fix Design pass (`detect`) timeouts

**Date:** 2026-09-09
**Goal:** Stop `run_impeccable detect` (chat label **Design pass**) from always hitting the 60s kill on omitted `target`.

## Context

Agents call `{ command: "detect" }` with no `target`. The handler used to force `target = "."` so the CLI would not wait on stdin. The Impeccable walker then scanned every `.ts` / `.js` / `.css` / `.html` file except a short skip list — Minnow's `src/` alone is ~1,400 files, and `.` also walks `server/`, `test/`, `scripts/`, `.tmp-*`. The child was killed at 60s:

`Error: run_impeccable (detect via impeccable cli) timed out after 60s (cwd .)`

`npm run impeccable:detect` already scopes to `src/ index.html`. UI Designer only edits `index.html`, `src/styles/**`, and `src/ui/**`.

A second false-failure: detect exits **2** when it found anti-patterns; the wrapper prefixed `Error: impeccable detect exited 2`.

## Implementation

- [`server/impeccable/run-impeccable.js`](../../server/impeccable/run-impeccable.js) — `resolveDetectTargets`, URL reject, `--json`, exit 2 as success (never prefix `Error:`), SIGTERM then SIGKILL/`taskkill /T /F`, timeout copy names scanned paths.
- Chat cards treat any `Error:` prefix as a failed run ([`isToolResultFailure`](../../src/ui/tool-messages.ts)). [`src/lib/impeccable-detect-result.ts`](../../src/lib/impeccable-detect-result.ts) still classifies a leftover `Error: impeccable detect exited 2` banner as success so old server output does not paint **failed**.
- [`test/impeccable/run-impeccable.test.mjs`](../../test/impeccable/run-impeccable.test.mjs) — defaults, no stdin hang, URL reject, exit 2.
- Schema: [`src/tools/definitions.ts`](../../src/tools/definitions.ts)
- Docs: [`src/skills/impeccable/SKILL.md`](../../src/skills/impeccable/SKILL.md), [`documentation/context.md`](../context.md)

## Out of scope

- `live` command hangs
- Changing upstream `walkDir` skip lists (overwritten by `impeccable:sync`)
