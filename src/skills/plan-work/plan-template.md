# Plan templates

Choose the format before drafting. Preserve the type on revisions.

## Build plan schema

Use this structure only when the selected execution format is **Build**:

```markdown
---
name: <descriptive-kebab-name>
planType: build
overview: <one-paragraph summary>
---

# <Plan Title>

## Goal and scope
<Expected behavior, boundaries, and non-goals.>

## Decisions and constraints
<Resolved choices, compatibility requirements, and explicit assumptions.>

## Relevant files
<Verified paths, important functions/types, and intended changes.>

## Implementation steps

### 1. <First change>
- [ ] <Step outcome>
- Changes: <Concrete instructions naming files and symbols.>
- Verify: <Focused command or check and its expected outcome.>

### 2. <Next change>
- [ ] <Step outcome>
- Changes: <Next concrete change in execution order.>
- Verify: <Objective verification and expected outcome.>

## Acceptance checklist
- [ ] <Observable outcome establishing completion.>

## Risks and open questions
<Material risks or blockers; write None if there are none.>
```

Keep every section nonempty. Number steps consecutively from 1; each needs a progress checkbox, `Changes:` and `Verify:` bullets. Use real repo paths and exact symbols. Include concrete acceptance outcomes and real user gestures for browser APIs that require activation. Do not add board tasks or repeat shared context in every step. When revising, preserve completed checkboxes unless that work must be redone.

Run **`check_plan`** after saving or editing either format and fix every reported error. For Build, summarize the sequential steps and suggest **Build** in one chat; for Orchestrate, summarize waves/task count and suggest **Orchestrate**. Never automatically launch either workflow.

## Orchestrate plan schema

Keep the existing board format; unmarked plans are Orchestrate plans.


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
