## Your stage: Plan

You write the **build plan**: a document an orchestrator splits into tasks and hands, one at a time, to builder agents that have never seen this conversation. Every task must stand on its own.

Read the build spec{{researchNote}} before you write, then explore the code the plan touches. Save the plan with `save_file` to exactly `{{planPath}}` (overwrite it if it exists; never choose another name).

### Required format

The file is parsed by the board scheduler, not interpreted — follow this exactly:

```markdown
---
name: {{planName}}
overview: <one-paragraph summary>
todos:
  - id: W1-A
    content: "Wave 1: <task title>"
    status: pending
  - id: W2-A
    content: "Wave 2: <task title>"
    status: pending
isProject: true
---

# <Plan title>

**Goal:** <one sentence>
**Spec:** `{{specPath}}`
**Granularity:** {{granularity}}

## Context
Why this work is needed, the constraints that shape it, and the decisions from the spec it depends on.

## Architecture / Key Files
| File | Role | Action |
|------|------|--------|
| `src/example/file.ts` | what it does | MODIFY / CREATE / DELETE |

## Wave Breakdown

### Wave 1 — <name>

#### Task W1-A: <title>
- **Build:** the steps, with exact file paths and the functions or types to add or change
- **Test:** the command to run and the assertion that proves it works
- **Accept:** one observable outcome that proves the task is done
- **Touches:** comma-separated repo-relative globs this task may write, e.g. `src/sync/**`
- **Depends on:** task ids this task needs first (omit when none)

## Verification Checklist
- [ ] project-wide checks (tests, build, lint) with their commands

## Notes for Build Agents
Conventions, gotchas and decisions a builder must not undo.
```

### Quality bar

- Every task has **Build**, **Test**, **Accept** and **Touches** as `- **Label:**` bullets. Nested lists under Build are fine.
- **Build** names the symbols to add or change, not just files, so a builder can find the impact with `who_calls`.
- **Test** is objective: a command and what its output must show. "Looks right" is not a test.
- **Accept** is a fact about the running system, not a process step.
- **Touches** lists what the task actually writes. Tasks run in parallel only when their Touches do not overlap, so over-broad globs cost parallelism and narrow ones cause conflicts.
- Tasks without **Depends on** start immediately; waves do not sequence themselves. Dependencies must name tasks in this plan and must not form a cycle.
- In an empty workspace, Wave 1 is a single scaffold task and every later task depends on it.
- The front-matter `todos` list every task id exactly once, and every `#### Task` heading has a todo.
- Granularity **{{granularity}}**: {{granularityHint}}
- Use real paths you have verified. No placeholders, no implementation code.

### Report

Call `report_outcome` with a `summary` of the plan (waves, task count, the riskiest part). When you revised the plan in response to review findings, list each finding in `addressed` as `{ "id", "disposition": "fixed" | "partly" | "declined", "note" }`.
