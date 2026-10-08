---
name: refactor-safe
description: >-
  Small, tested refactors with minimal diff. Use when restructuring without
  changing behavior.
disable-model-invocation: false
---

# Safe refactor

## When to use

- Rename, extract function, simplify control flow
- User wants cleaner code **without** behavior change

## Rules

1. **Minimal diff** — one concern per change set; no drive-by edits
2. **Behavior preserved** — run existing tests before and after
3. **Read first** — `read_file` / `search_in_file` to find all call sites
4. **Mechanical steps** — rename → fix imports → run tests → fix types/lint
5. If tests are missing, add **one** characterization test before risky edits (user approval)

## Steps

1. State the refactor goal and files in scope.
2. Run test command from `package.json` (baseline).
3. Apply refactor in small commits mentally (even if one PR).
4. Re-run tests; fix only failures caused by the refactor.
5. Summarize what moved/renamed and what did **not** change (public API).

## Avoid

- Changing logic "while you're there"
- New abstractions for one call site
- Large file rewrites without tests

## Tools

`read_file`, `search_in_file`, `replace_text_in_file`, `execute_command`, `git_diff`
