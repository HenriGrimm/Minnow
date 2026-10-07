---
name: docs-update
description: >-
  Update README and documentation/context.md after code changes. Use when docs are
  stale or user asks to document.
disable-model-invocation: false
---

# Documentation update

## When to use

- Feature shipped and docs should reflect behavior
- User asks to update README, context, or verification notes

## Steps

1. Read `documentation/context.md` for project truth — align new text with existing structure.
2. Identify what changed in code (API routes, config paths, UI, tools).
3. Update **user-facing** docs: `README.md` only if setup/usage changed.
4. Update `documentation/context.md` sections: layout, APIs, composer behavior, tests.
5. If a build step exists, add or update `documentation/plans/verification/step-NN.md` when requested.
6. Keep prose concise; use tables for paths and routes.
7. Do not document secrets or local-only overrides in committed files.

## Minnow locations

| Doc | Purpose |
|-----|---------|
| `documentation/context.md` | Living architecture + APIs |
| `documentation/plans/verification/` | Step acceptance commands |
| `README.md` | Quick start |

## Tools

`read_file`, `save_file`, `search_in_file`, `list_directory`, `git_diff`
