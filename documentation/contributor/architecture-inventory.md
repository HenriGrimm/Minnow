# Architecture inventory

Generated from the tool catalog, app and mode registries, and shipped skill manifest.
Run `npm run architecture:generate` after changing a registry; CI checks drift with
`npm run architecture:check`. Do not edit the inventory by hand.

| Inventory | Current registry |
| --- | --- |
| Built-in tools | 111 (0 app-gated) |
| Released apps | 8: Home, Code, Source Control, Models, Brain, Scheduler, Issues, Settings |
| Hidden apps | 4: Research, Experts, Benchmarking, Compare |
| Available modes | 6: General, Build, Plan, Orchestrate, Debug, Onboarding |
| Composer modes | 4: General, Build, Plan, Debug |
| Bundled skills | 21: ask-user, browser-automation, build-plugin, caveman, code-review, create-pr, debug-error, docs-update, explain-code, fix-ci, frontend-design, git-setup, git-commit, impeccable, orchestrate-plan, partymode, plan-work, refactor-safe, security-review, ui-designer, write-tests |

Hidden apps remain in the codebase; they are omitted from shipped navigation and launches.
Persisted legacy mode IDs are normalized separately from the available mode list.
