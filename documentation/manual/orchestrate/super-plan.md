# Super Plan

Super Plan is for the ideas that are too vague to build. Instead of answering your one-paragraph request with a plan that quietly invents your requirements, it interviews you first, then researches, drafts, has a reviewer critique the draft, redrafts, and presents a plan you can hand to a board.

It is slower than asking for a plan. That is the entire point.

## Starting one

Open the caret under **Plan** in the composer and choose **Super Plan**, or start from the Orchestrate plan screen. Describe what you want in as much or as little detail as you have.

**New plan** (left rail, or Make a plan from Orchestrate) always starts a fresh Super Plan chat. Any pipeline already running keeps going on its own chat. Those runs also appear in the Code chat sidebar from the moment the pipeline starts, with an interim title until you confirm the build spec.

On the compose screen, pick the model on the composer bar (same catalog as Code). That binding is what interview and drafts use unless you set separate stage overrides in Settings. The sparkles control beside **Start planning** expands your draft into a fuller prompt in place before you send.

Super Plan writes plans and reference documents. Like Plan mode, it cannot edit the rest of your repository — the mutating file and git tools are removed. Issue tracker tools stay available, so a Super Plan turn can file, update, and attach a plan to an Issues card.

## The pipeline

| Stage | What happens |
|-------|--------------|
| **Interview** | The model asks you batches of questions about scope, constraints and priorities |
| **Build spec** | Turns your answers into a written spec — a checkpoint you confirm or revise |
| **Research** | Runs the Deep Research engine over the web, your codebase, or both |
| **Draft** | Writes the plan and revises it using review feedback |
| **Review** | A separate reviewer checks the plan and reports structured findings; repeats up to the configured limit |
| **Polish** | Refines interface details when enabled |
| **Accept plan** | Shows the final document for acceptance or requested changes |

A progress panel tracks stages as they run; the research stage embeds the research progress view so you can watch sources arrive.

You get **two checkpoints** — after the interview and at the end. At the first you can confirm the spec or send it back for revision. Confirming a spec you have not read defeats the purpose; that document is what the remaining stages build from.

You can pause the pipeline and resume it later. The server journals progress and restores unfinished runs after a restart. Research, review and polish can run with the window closed; interview and drafting wait for an open Minnow window.

### The interview

The stage worth sitting through. It asks in structured batches — around 20 questions by default — about the things a plan silently assumes: who uses this, what happens when it fails, what is explicitly out of scope, what must not break.

Answering "you decide" to everything produces a plan where the model decided everything. That is a legitimate choice, but be aware you made it.

## Configuration

**Settings → Agents → Super Plan pipeline**:

| Setting | Default | What it does |
|---------|---------|--------------|
| **Review rounds** | 2 | 0 skips review entirely; 1 gives one critique and one rewrite; up to 4 |
| **Review timeout** | 20 min | How long one review pass may run before the stage gives up (5–120). Raise it for slow reviewer models or large plans |
| **Interview** | On | Turn off to skip straight to the spec |
| **Question budget** | ~20 | Between 5 and 40 |
| **Research** | On | Turn off when you already know the domain |
| **Research scope** | Web + codebase | Or one of them |
| **Research depth** | Auto | Or quick / standard / deep, or an explicit round count |
| **Impeccable** | Auto | Auto runs the UI pass when the plan involves interfaces; or always, or never |
| **Stage models** | Inherit | Separate model bindings for research, the reviewer, and the planner |

**Stage models are the highest-leverage setting here.** The reviewer is doing the hardest thinking in the pipeline — finding what a plan is missing. Binding a strong model to the reviewer and a cheaper one to the drafting turns often gives better plans than running everything on one mid-tier model.

**Plan granularity** — large, medium or small — lives in the same section and controls how finely the resulting plan is split into tasks. That directly shapes the board you get next.

If a review pass keeps getting cut short, raise the reviewer timeout under Settings → Agents → Super Plan pipeline. Generation idle and max-duration limits live under [Settings → Agents → Watchdog](../apps/settings.md).

## What you end up with

Three documents in your workspace:

| File | Contents |
|------|----------|
| `documentation/plans/<slug>.md` | The plan |
| `documentation/plans/references/<slug>-spec.md` | The spec from the interview |
| `documentation/plans/references/<slug>-research.md` | The research report |

`<slug>` comes from the confirmed build spec's first `#` heading, with a short run suffix to keep different plans separate. Before confirmation, the spec uses an interim request-based name. The research report is present only when research completes.

Review can stop when no blocking findings remain, its round limit is reached, or consecutive rounds make no progress. Check remaining findings and disputed fix claims before accepting. Pipeline settings are captured when a run starts; changes apply to new runs.

They are ordinary markdown in your repository. Commit them, review them in a pull request, edit them by hand.

Executable task plans can be handed to an [orchestrate board](boards.md). Prose planning documents remain available for reading and revision.

## Plan, Super Plan, or a board?

| Situation | Use |
|-----------|-----|
| You know what you want; you need it written down | **Plan** mode |
| The idea is real but the requirements are not settled | **Super Plan** |
| The plan exists and you want it built | **Orchestrate board** |
| Small enough to just do | **Build** mode |

## Related

- [Orchestrate boards](boards.md)
- [Modes](../concepts/modes.md)
- [Research app](../apps/research.md)
- [Agents, sub-agents, and packs](agents.md)
