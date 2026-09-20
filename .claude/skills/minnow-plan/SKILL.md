---
name: minnow-plan
description: Write an implementation plan in Minnow's orchestrator board schema — front matter with todos, waves, and tasks carrying Build/Test/Accept/Touches. Use when asked for a Minnow plan, an orchestrate/board plan, a wave plan, or a plan under documentation/plans/. Validates the result with Minnow's own parser.
---

# Minnow plan

## What this produces

Write `documentation/plans/<kebab-slug>.md` at the top level of the current Minnow checkout. The plan picker uses `ORCHESTRATE_PLANS_PREFIX` in `src/chat/plans/plan-path.ts`. Do not put board plans under `references/` or `verification/`, or use a `-spec.md` or `-research.md` suffix; those files are filtered from the picker.

## Process

1. Restate the request in one sentence. Ask clarifying questions only when scope is genuinely ambiguous. Use `AskUserQuestion` with related questions batched; if the codebase can answer one, read it instead.
2. Explore the relevant code, real file paths, conventions, and test setup before writing. Use `Explore` subagents when the surface is wide. Never use placeholder paths in the finished plan.
3. Choose `large`, `medium`, or `small` granularity and state it in the header. Default to `medium`.
4. Write the plan file.
5. Run `node .claude/skills/minnow-plan/scripts/validate-plan.mjs documentation/plans/<slug>.md`. Fix every error and rerun until it exits cleanly. A plan is not done without a clean run.
6. Report the path, wave count, task count, and successful validation.

## Schema

Use the planner's schema. Replace every placeholder with findings from this checkout, and keep the `todos` and task headings in sync.

```markdown
---
name: <plan-kebab-name>
overview: <one-paragraph summary>
todos:
  - id: W1-A
    content: "Wave 1: <task title>"
    status: pending
  - id: W1-B
    content: "Wave 1: <task title>"
    status: pending
  - id: W2-A
    content: "Wave 2: <task title>"
    status: pending
isProject: true
---

# <Plan Title>

**Date:** <today>
**Goal:** <one-sentence goal>
**Granularity:** large | medium | small

## Context
Why this work is needed, what prompted it, intended outcome, constraints.

## Architecture / Key Files
| File | Role | Action |
|------|------|--------|
| `src/foo/bar.ts` | <role> | MODIFY |
| `src/baz/new.ts` | <role> | CREATE |

## Wave Breakdown

### Wave 1 — <Name>
Tasks here run concurrently unless they declare `Depends on:`.

#### Task W1-A: <Title>
- **Build:** <specific steps; file paths; **exact function/type names to add or change**; expected diff scope>
- **Test:** <specific assertions; commands to run; expected output that proves success>
- **Accept:** <one observable outcome that proves this task is done — e.g. "the /foo route returns 200 with field bar">
- **Touches:** <comma-separated repo-relative globs this task may write — e.g. `src/foo/**`, `server/bar/*.js`>
- **Depends on:** <comma-separated task ids, or omit>

#### Task W1-B: <Title>
- **Build:** ...
- **Test:** ...
- **Accept:** ...
- **Touches:** ...
- **Depends on:** <omit if no dependency>

### Wave 2 — <Name>

#### Task W2-A: <Title>
- **Build:** ...
- **Test:** ...
- **Accept:** ...
- **Touches:** ...
- **Depends on:** W1-A, W1-B

## Verification Checklist
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] <other project-wide assertions>

## Notes for Build Agents
<Tone, conventions, gotchas the builders need to know.>
```

## Hard rules

- Line 1 is `---`. Front matter needs a kebab-case `name` and a non-empty `todos` list. New plans use `status: pending`; `completed` describes finished work.
- Every `todos` id must equal a `#### Task` id exactly, one-to-one in both directions. `w1-foo` beside `#### Task W1-A:` is the common mismatch. The parser compares case-insensitively, but use identical spelling and case for clarity.
- `## Wave Breakdown` is required and literal. Tasks outside it are silently ignored. Use `### Wave N — Name` and `#### Task <id>: <Title>`. Task ids are unique, and no task comes before its wave heading.
- Every task needs non-empty `- **Build:**`, `- **Test:**`, `- **Accept:**`, and `- **Touches:**` fields.
- `Touches` names at least one repo-relative file or glob. No leading `/` or `C:\`, `..` path component, `{}` braces, leading `!`, whitespace, parentheses, or unbalanced `[` and `]`.
- `Depends on:` is optional. Its ids must exist, with no self-reference or cycles. `(none)`, `—`, and omission parse as empty.
- Waves do not sequence tasks. Only `Depends on:` blocks a task. Two tasks run concurrently only when their `Touches` sets do not intersect. Broad globs cost parallelism; overly narrow ones risk conflicts.
- Avoid implementation-language code fences. Minnow's no-code guard rejects recognized languages such as `typescript`, `python`, and `css` anywhere in the plan; other unsupported fence languages are rejected outside a `**Test:**` section.
- For a greenfield workspace, Wave 1 has one scaffold task and every later task depends on it.

## Quality bar

`Build` names exact symbols and paths, not just files. `Test` names a command and a concrete assertion. `Accept` states one observable fact about the running system or artifact. Each task must stand on its own for an agent with no chat history.

Read [reference/schema.md](reference/schema.md) when a parser error needs diagnosis. Use [reference/example-plan.md](reference/example-plan.md) for a known-good full example.
