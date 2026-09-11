# Super Plan

Super Plan is for the ideas that are too vague to build. Instead of answering your one-paragraph request with a plan that quietly invents your requirements, it asks you what the code cannot tell it, has you confirm a written spec, researches, drafts, has a separate reviewer critique the draft, revises, and hands you a plan to accept.

It is slower than asking for a plan. That is the entire point.

## Starting one

Open **Super Plan** from the Code view bar, choose **Super Plan** as the mode and send from the composer, or use **Make a plan** in Orchestrate. Describe what you want in as much or as little detail as you have.

**New plan** at the top of the plan list always starts a fresh one. A plan that is already running keeps going; every plan is its own chat, listed in the Code chat sidebar from the moment it starts and named after the spec once it has one.

The composer's chips set the pipeline for this plan (interview, research, review rounds, interface polish) and become the default for the next one. The model on the composer bar is used for the planner unless Settings binds a separate one. The sparkles control expands your brief into a fuller prompt before you send.

Super Plan writes plans and reference documents. It cannot edit the rest of your repository; each stage may save only its own document.

## The pipeline

| Step | What happens |
| --- | --- |
| **Interview** | The model explores your workspace, then asks batches of questions about what the repository cannot answer, and writes a build spec |
| **Spec review** | Checkpoint: read the spec, confirm it, or ask for changes in your own words |
| **Research** | Deep Research over the web, your codebase, or both, with the spec as the brief |
| **Plan** | Writes the plan in board format and checks it: headings, task steps, no implementation code |
| **Review** | A separate reviewer reports findings (blocker, warning, note) with suggested fixes; the planner revises |
| **Polish** | Adds interface detail to the tasks that touch the UI, when enabled |
| **Accept** | Checkpoint: accept the plan, ask for changes, or run another review round |

Every step runs on the local server. You can close the window, and a plan picks up where it was after Minnow restarts. When a plan needs you (questions, a checkpoint, or a stage that keeps failing) its row shows a dot and you get a notification.

### The interview

The step worth sitting through. Questions come in batches with the planner's recommended answer marked; **Use recommended** fills them all in, and **Other** takes your own answer. It asks only what it could not learn from the repository, up to the question limit, and stops early when it has enough. **Stop asking** has it write the spec with what it knows.

Answering "you decide" to everything produces a plan where the model decided everything. That is a legitimate choice, but be aware you made it.

### Checkpoints

Checkpoints never time out. At the spec checkpoint, confirming a spec you have not read defeats the purpose; that document is what the rest of the plan builds from. **Request changes** takes notes in plain words and revises the spec with them.

At the plan checkpoint, open review findings are called out before you accept. You can ask for changes as many times as you like, or run one more review round. An accepted plan can be reopened later from the same card.

### When something goes wrong

A step that fails three times in a row stops the plan and says why. **Retry** runs it again from where it stopped, with a fresh set of attempts. Research, review and polish can also be skipped, and a failing optional step is skipped for you. Only **Cancel** ends a plan; the files it wrote are kept.

## Reading a run

The run page has the checkpoint card at the top, when there is one, and these tabs:

- **Activity**: your request, each step's work as it happened (reasoning, tool calls, what it wrote), and your decisions between them. The step that is running streams live.
- **Spec**, **Research**, **Plan**: the documents, with a link to open them in the editor.
- **Review**: every review round with its findings, which were resolved, and why review stopped.

The pipeline column beside them shows each step's state and time. **Redo** reruns a finished step (the interview, research, the plan, review, polish) and everything after it; **Skip** skips the optional step that is running. The **⋯** menu renames the plan, opens or copies the plan file, and deletes the plan.

## Configuration

**Settings → Agents → Super Plan pipeline** holds the defaults the composer chips start from:

| Setting | Default | What it does |
| --- | --- | --- |
| **Review rounds** | 2 | 0 skips review; up to 4. Review stops early when nothing blocking is left, or when a round repeats the last one |
| **Review timeout** | 20 min | How long one review pass may run (5–120). Raise it for slow reviewer models or large plans |
| **Interview** | On | Off writes the spec straight from your request |
| **Question limit** | 20 | The most questions the interview may ask, between 5 and 40 |
| **Research** | On | Turn off when you already know the domain |
| **Research scope** | Web + codebase | Or one of them |
| **Research depth** | Auto | Or quick / standard / deep, or an explicit round count |
| **Polish** | Auto | Auto runs it when the plan has UI work; or always, or never |
| **Stage models** | Inherit | Separate model bindings for research, the reviewer, and the planner |

**Stage models are the highest-leverage setting here.** The reviewer is doing the hardest thinking in the pipeline: finding what a plan is missing. Binding a strong model to the reviewer and a cheaper one to the planner often gives better plans than running everything on one mid-tier model.

**Plan granularity** (large, medium or small) lives in the same section and controls how finely the plan is split into tasks. That directly shapes the board you get next.

A plan keeps the settings it started with; changes apply to the next plan.

## What you end up with

Up to three documents in your workspace:

| File | Contents |
| --- | --- |
| `documentation/plans/<slug>.md` | The plan |
| `documentation/plans/references/<slug>-spec.md` | The spec from the interview |
| `documentation/plans/references/<slug>-research.md` | The research report, when research found something |

`<slug>` comes from the spec's first `#` heading; if another plan already uses that name, a short run suffix is added. Until the spec exists the run uses an interim name.

They are ordinary markdown in your repository. Commit them, review them in a pull request, edit them by hand. The plan list also shows plan files you wrote yourself.

From an accepted plan, **Start Orchestrator** hands it to an [orchestrate board](boards.md) and **Build in a chat** opens a Build chat on it.

## Plan, Super Plan, or a board?

| Situation | Use |
| --- | --- |
| You know what you want; you need it written down | **Plan** mode |
| The idea is real but the requirements are not settled | **Super Plan** |
| The plan exists and you want it built | **Orchestrate board** |
| Small enough to just do | **Build** mode |

## Related

- [Orchestrate boards](boards.md)
- [Modes](../concepts/modes.md)
- [Research app](../apps/research.md)
- [Agents, sub-agents, and packs](agents.md)
