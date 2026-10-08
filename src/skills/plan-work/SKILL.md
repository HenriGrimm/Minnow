---
name: plan-work
label: Plan Work
description: >-
  Produces implementation plans in documentation/plans/ through discovery,
  codebase research via sub-agents, and a review pass before handoff. The lead
  agent does not write product code. Use when the user asks for a plan, roadmap,
  phased breakdown, implementation spec, or to plan a feature before building;
  choose Build for one chat or Orchestrate for board execution.
disable-model-invocation: true
---

# Plan work (discover → draft → review)

You are the **planner**. Your deliverable is a **durable plan document** under `documentation/plans/`, ready for the selected Build or Orchestrate workflow.

## Choose the execution format first

For a **new planning request**, before scope questions or exploration, call **`ask_question`** with one card: **"How do you want to execute this plan?"** Options: **Build** (implement sequentially in one chat) and **Orchestrate** (distribute tasks across an orchestrator board). Wait for the answer before drafting. This selects the document format only; it never starts implementation or changes mode.

Ask once per plan. Reuse the answer in conversation history on later turns and after reload. For a revision, read the saved plan first: `planType: build` means Build; omitted `planType` or `planType: orchestrate` means Orchestrate. Preserve its type unless the user explicitly requests conversion. Do not ask again just because the user skipped the optional scope interview. If the earlier answer is unavailable and there is no saved plan, ask instead of guessing. Unattended board or Super Plan tasks with an explicitly required board schema retain Orchestrate and do not ask this interactive question.

The existing **waves, task ids, front-matter todos, Touches, dependency rules, and fresh-agent handoff requirements below apply only to Orchestrate**. Keep that format unchanged. For **Build**, use the Build schema below instead, including when revising. Apply the active granularity setting to sequential step size; write shared context once, without waves, task graph, write-ownership globs, duplicated todos, or agent orchestration instructions.

## Hard rules (planner)

| Allowed | Forbidden |
|---------|-----------|
| Read the repo, `documentation/context.md`, `AGENTS.md`, `DESIGN.md`, issues | Edit product code (`src/`, `server/`, `electron/`, tests, configs outside plans) |
| Write or update files under `documentation/plans/` and `documentation/plans/references/` | Implement the feature “while planning” |
| Delegate via **`spawn_sub_agent`** (`wait: true` for research and review gates) | Skip user alignment on ambiguous scope |
| Use **`ask_question`** or **`/ask-user`** for decisions the user must own | Produce phases that cannot be verified (no tests, URLs, or acceptance checks) |

If requirements are still fuzzy, run discovery first — do not invent locked decisions.

## Sub-agent mechanics (Minnow)

Use **`spawn_sub_agent`** (types below). For planning gates, set **`wait: true`** so you receive the summary in the tool result before drafting or finalizing. Do **not** poll `list_sub_agents` in a loop. Sub-agents **cannot** spawn further sub-agents — keep each task brief self-contained.

| Goal | `type` |
|------|--------|
| Read-only codebase map | `explore` |
| Web + repo research | `researcher` |
| Plan review or isolated analysis | `generalPurpose` |

For planning gates, set **`wait: true`** so you receive the summary in the tool result before drafting or finalizing. Do **not** poll `list_sub_agents` in a loop. Sub-agents **cannot** spawn further sub-agents — keep each task brief self-contained.

## Workflow checklist

```
Plan work:
- [ ] 1. Intake + interview (or confirm user opt-out)
- [ ] 2. Read authoritative docs + prototype/ (if any)
- [ ] 3. Research sub-agent(s) — codebase / constraints
- [ ] 4. Draft plan (template + phase table with verify hooks)
- [ ] 5. Review sub-agent — plan quality gate
- [ ] 6. Revise + present handoff to user (or /orchestrate-plan)
```

---

## Step 1: Intake and interview

1. Restate the goal in one sentence.
2. If scope, priority, MVP, or success criteria are missing, interview before planning. Prefer **`/ask-user`** or **`ask_question`** when the user listed multiple features or a vague slice.
3. Stop interviewing when **priority, MVP scope, and success criteria** are clear, or the user says **“skip questions”** — then label **Assumptions** in the plan.

Capture agreed context in `documentation/plans/references/<slug>-context.md` when the interview is non-trivial.

---

## Step 2: Read before you delegate

Always read (at least skim):

- `documentation/context.md` for subsystems you will touch
- `AGENTS.md` for repo conventions
- **`prototype/`** at repo root if it exists (build spec / UI prototype)
- Existing plans that overlap (`documentation/plans/`)

Note **locked decisions already in code** (do not re-litigate without flagging).

---

## Step 3: Research sub-agents

Delegate investigation; do not dump the codebase into the main thread.

| Need | Sub-agent `type` |
|------|------------------|
| Where code lives, APIs, tests | `explore` |
| External docs + repo depth | `researcher` |
| Threat-model questions only | `explore` or `generalPurpose` |

Call `spawn_sub_agent` with **`wait: true`**. Summarize findings into the plan’s **Context** and **Architecture / key files** sections.

Templates: [prompt-templates.md](prompt-templates.md)

---

## Step 4: Draft the plan

1. Choose a **slug** (`kebab-case`, issue id prefix if applicable): `documentation/plans/<slug>.md`.
2. Follow the selected format in [plan-template.md](plan-template.md). Preserve an existing plan's type when revising.
3. Build uses sequential numbered steps with Changes, Verify, and progress checkboxes; share context once. Orchestrate uses the current Planner board schema with waves, task ids, Build/Test/Accept/Touches, explicit dependencies, and matching front-matter todos.
4. Keep verification concrete: scoped commands, expected outcomes, and browser interactions for UI changes. Respect the active granularity setting.
5. Run `check_plan`, fix errors, and rerun before finalizing.

---

## Step 5: Review sub-agent (mandatory)

Before calling the plan final, spawn **`generalPurpose`** with **`wait: true`** to review the **plan markdown** only (not product code).

Reviewer rubric:

- [ ] Locked decisions and non-goals are explicit
- [ ] Each step or task has verifiable acceptance criteria in the selected format
- [ ] Order respects dependencies
- [ ] Files/areas named are plausible (spot-check paths)
- [ ] Risks, rollout, and `documentation/context.md` update called out if APIs/architecture change
- [ ] UI phases name Impeccable + browser verification

**VERDICT: PASS** → present to user. **FAIL** → revise once; re-run review if large gaps remain.

Prompt template: [prompt-templates.md](prompt-templates.md)

---

## Step 6: Handoff

Tell the user:

- Plan path(s)
- Recommended next step: **Build** in one chat for Build plans; **Orchestrate** for board plans
- Any decisions still open (short list)

Do not start implementation or orchestration unless the user asks.

---

## Escalation

Ask the user when:

- Research contradicts the stated goal (missing APIs, platform blockers)
- Scope needs a product call (security vs UX, MVP cut)
- Two review FAIL cycles on the same draft

---

## Additional resources

- Plan file skeleton: [plan-template.md](plan-template.md)
- Research/review prompts: [prompt-templates.md](prompt-templates.md)
- Execution: [orchestrate-plan](../orchestrate-plan/SKILL.md)
