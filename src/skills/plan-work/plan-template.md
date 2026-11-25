# Plan templates

Every plan uses the Build schema below.

## Build plan schema

Use this structure for every plan:

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

Keep every section nonempty. Number steps consecutively from 1; each needs a progress checkbox, `Changes:` and `Verify:` bullets. Use real repo paths and exact symbols. Give each browser check an observable pass condition. Include concrete acceptance outcomes and real user gestures for browser APIs that require activation. Do not repeat shared context in every step. When revising, preserve completed checkboxes unless that work must be redone.

Run **`check_plan`** after saving or editing a plan and fix every reported error. Summarize the sequential steps and suggest **Build here** or **`/factory <plan path>`**. Never launch either yourself.
