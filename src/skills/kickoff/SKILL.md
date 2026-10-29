---
name: kickoff
label: Kickoff
description: >-
  Kickoff for a new project, app, or feature: grill, PRD, design, then a plan.
  Use when the user wants to start, set up, scope, or spec something new before
  building it. Not when a plan already exists.
user-invocable: true
disable-model-invocation: false
argument-hint: "[project, app, or feature to kick off]"
---

# Kickoff

Take one new project, app, or feature from an idea to a saved plan. Five stages run in order, and Kickoff writes documents only, never product code.

A **gate** is the user's confirmation before the next stage starts. Stages 1 and 2 end with one `ask_question` card: **Continue**, **Revise**, **Stop**. Stages 3 and 4 run Impeccable flows that end with their own confirmation; that confirmation is the gate, so don't add a second card. Never start a stage before the previous gate passes.

## Resume from disk

Work out the current stage from files, not chat memory. The chat may have been reloaded or compacted, and an agent-started run is not pinned to the chat.

Find the **slug** first: from the user's message, from root `PRD.md`'s header, or by listing `documentation/plans/references/*-context.md`. If more than one candidate fits, ask which one.

| On disk | Resume at |
|---------|-----------|
| No `<slug>-context.md` | Stage 1 |
| Context file; no PRD | Stage 2 |
| PRD; UI work; no `PRODUCT.md` | Stage 3 |
| UI work; no design artifact | Stage 4 |
| Stages done or skipped; no `documentation/plans/<slug>.md` | Stage 5 |
| Plan exists | Finish |

Paths by Kind:

| Artifact | `project` | `feature` |
|----------|-----------|-----------|
| Context recap | `documentation/plans/references/<slug>-context.md` | same |
| PRD | root `PRD.md` | `documentation/plans/references/<slug>-prd.md` |
| Design artifact | `DESIGN.md` | `documentation/plans/references/<slug>-design.md` |

An adopted PRD (see Stage 1) keeps its own path; the context file records where it is.

## Mode check

Stages 2–4 can write outside `documentation/plans/` (`PRD.md`, `PRODUCT.md`, `DESIGN.md`), which Plan mode denies. If the chat is in Plan mode before Stage 5, ask to switch to General or Build before writing. Kickoff still writes only documents in either mode.

## Stage 1: Grill

**Grill** the user until you understand the project and the context it will be built in. Ask one question at a time. With each question, give your recommended answer and why. Before asking, check whether the workspace or the user's own material answers it; if so, read instead of asking.

Write for a junior developer by default: plain language, short sentences, and questions about expected behavior and priorities. Resolve routine implementation details from the repo; briefly explain necessary technical terms. Describe options by their practical effect and include your recommendation's reason and main tradeoff in the card. Use more technical language if the user requests it.

1. **Start from what exists.** Read any spec in the user's message and any PRD or spec document they point to. Grill only its gaps; don't re-ask what it settles.
2. **Kind.** Inspect the workspace. Empty or new repo → `project`. Existing codebase → `feature`. For a feature, read the relevant code, `documentation/context.md`, and `AGENTS.md` before the first question.
3. **Slug.** Propose a short kebab-case slug for the work and confirm it with the user. Every path depends on it.
4. **Grill each branch.** Follow each answer down until it's settled, and resolve a decision before asking about anything that depends on it:
   - **Problem and why now:** what's broken or missing, for whom, and what happens if it isn't built
   - **Users:** who uses it and what they're trying to get done
   - **Boundary:** what's in, what's explicitly out, and the smallest version worth shipping
   - **Build context:** stack, runtime and hosting, existing code or services to extend or integrate, data and storage, and hard constraints (deadlines, platforms, compliance, budget)
   - **Interface:** `UI` if anything is user-facing on screen; otherwise `no-UI` (backend, CLI, library, infrastructure)
   - **Done:** observable success criteria
   - **Risks:** the unknowns most likely to change the plan
5. **Leave brand and visual taste alone.** Impeccable init (Stage 3) and the design stage ask about register, personality, anti-references, and accessibility; don't ask them here.
6. **Execution.** Close the grilling with one `ask_question` card, "How would you like to build this?", with options **Build** (one agent works through the steps in this chat) and **Orchestrate** (several agents share the work on a task board). The user decides; do not choose for them. This is the same plan-format question Plan mode asks, so Stage 5 reuses the answer.
7. **Recap.** Summarize the settled answers in a short list, marking anything the user deferred. Save it to `documentation/plans/references/<slug>-context.md`, headed with slug, Kind, Interface, Execution, and the PRD path.

**Done when:** every branch is answered or explicitly deferred by the user, the slug and Execution are chosen, the recap is saved, and the user confirms it at the gate.

## Stage 2: Write the PRD

Write the PRD from the saved recap. Add nothing the grilling didn't establish; anything you had to infer goes under Assumptions. When adopting an existing PRD, edit it in place: add missing sections and header fields, and don't rewrite what the user wrote. Sections:

- Header: title, slug, Kind, Interface, Execution
- Problem
- Users
- Goals
- Non-goals
- Requirements (numbered, each testable)
- Build context (stack, integrations, data, constraints)
- Success criteria (observable)
- Risks and open questions
- Assumptions (anything the user has not confirmed)

**Done when:** the PRD is saved at its path, every section is present, the header records slug and the user's Execution choice, and the gate passes.

## Stage 3: Product context (Impeccable init)

- **No-UI work:** say "Skipping Impeccable init and design: no UI." and go to Stage 5.
- **`PRODUCT.md` already exists:** skip this stage without offering a refresh. If the grilling contradicts it, tell the user and add the conflict to the PRD's Risks and open questions.

Otherwise call `load_skill` with `id: "impeccable"` and `reference: "reference/init.md"`, then follow it with these overrides:

- The PRD is init's primary source for users, purpose, and goals. Ask only what it doesn't answer, usually register, brand personality, anti-references, and accessibility.
- Run init's Steps 1–4, plus Step 6 when it applies. Stage 4 replaces its Step 5; Finish replaces its Step 7.

**Done when:** `PRODUCT.md` exists with a Register section and the user has approved it in init's flow (or the stage was skipped).

## Stage 4: Design

1. **Direction (frontend-design).** Call `load_skill` with `id: "frontend-design"` and `reference: "reference/frontend-aesthetics.md"`, following `next_offset` through **Discover the Brief**, **Creative Direction**, **Match the Surface**, and **The Specificity Ladder**. Then run only the skill's first two workflow steps, *Understand the task* and *Choose a direction*, with the PRD and `PRODUCT.md` as inputs. For a new experience, propose 2–3 meaningfully different directions and let the user pick one with `ask_question`; for an existing app, the direction extends `DESIGN.md` rather than replacing it. If the guide can't be loaded, say so and continue with the workflow steps alone.
2. **Record (Impeccable).** Write the chosen direction down:
   - **No `DESIGN.md` yet:** load `reference/document.md` from the `impeccable` skill and follow it, using the chosen direction for its answers. It chooses seed mode before implementation and scan mode when code exists. For a `project`, `DESIGN.md` is the design artifact.
   - **`feature`:** after `DESIGN.md` exists, load `reference/shape.md` and run its discovery for this feature, with the PRD, `DESIGN.md`, and the chosen direction as inputs. After the user confirms the brief, save it to `documentation/plans/references/<slug>-design.md`.

Do not implement anything: skip frontend-design's implement, inspect, and deliver steps, and don't run `craft`. The design feeds the plan.

**Done when:** the user has picked a direction, the design artifact for the Kind exists with the direction recorded in it, and the user has confirmed it in Impeccable's flow.

## Stage 5: Plan

1. Ask with `ask_question`: "Switch to Plan mode to write the plan?" Options: **Switch to Plan** and **Stop here**. On a switch, call `set_chat_mode` with `plan`. The switch applies from your next tool call, so keep going in the same turn.
2. Follow Plan mode's workflow, using the context recap, the PRD, `PRODUCT.md`, and the design artifact as inputs. State the Execution choice from the PRD header ("Execution: Build, per the PRD") so Plan mode uses it without asking again.
3. Save the plan as `documentation/plans/<slug>.md`, and link the context recap, PRD, and design artifact in its context section. UI steps or tasks name `/frontend-design` for implementation and rendered verification, against the recorded direction.

**Done when:** the plan is saved and `check_plan` passes.

## Finish

The client shows Open plan / Build here / Orchestrate buttons once a plan is saved, so don't ask a next-step question. End with:

- Every path written: context recap, PRD, `PRODUCT.md`, design artifact, and the plan
- One line: **Recommended next step: Build** (smaller feature) or **Orchestrate** (larger feature or full app), matching the Execution choice
- Open questions carried over from the PRD, if any

If the user now wants the other execution path, the plan must be converted first: revise its type in Plan mode before they start.
