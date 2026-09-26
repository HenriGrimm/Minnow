# Skills and slash commands

Type **/** at the start of an empty composer and a picker opens. It holds two different kinds of thing:

- **Skills** — packaged instructions that shape how the model does one job.
- **Commands** — `/goal`, `/loop`, `/followup` and `/compact`, which change how the *chat* behaves rather than what the model is told.

Navigate with **↑ ↓**, choose with **Enter** or **Tab**, dismiss with **Escape**. Add your own text after the skill name before sending.

## Skills

A skill is a `SKILL.md` file: a short front matter block and a body of instructions. Invoking one prepends those instructions to your request. That is the whole mechanism — which is why writing your own is easy.

Twenty ship built in and all are enabled by default.

| Skill | What it does |
|-------|--------------|
| `/ask-user` | Gathers structured answers from you before starting large or ambiguous work |
| `/browser-automation` | Drives Minnow's built-in browser for login flows, SPAs and screenshots |
| `/caveman` | Ultra-compressed replies — cuts token use sharply while keeping technical accuracy |
| `/code-review` | Security, correctness and style pass over a diff |
| `/create-pr` | Push the current branch and open a GitHub pull request with `gh` |
| `/debug-error` | Systematic trace of a tool failure or stack trace |
| `/docs-update` | Brings README and project docs back in line with the code |
| `/explain-code` | Teaches the code instead of changing it |
| `/fix-ci` | Investigates GitHub Actions failures, fixes scoped issues, and re-runs local CI gates |
| `/git-setup` | Initializes git in the workspace and connects a GitHub remote |
| `/git-commit` | Writes a conventional commit message from the staged diff |
| `/impeccable` | Design, critique and refine UI against the project's design system |
| `/orchestrate-plan` | Runs a multi-phase plan via sub-agents with a verify gate after each phase (orchestrator does not write product code) |
| `/partymode` | Bird Man, your local party animal |
| `/plan-work` | Discovery and phased plans in `documentation/plans/` via sub-agents (planner does not write product code) |
| `/refactor-safe` | Small, tested refactors with a minimal diff |
| `/security-review` | OWASP-style pass over changes or files |
| `/ui-designer` | UI audit with screenshots, then plan or implement |
| `/write-tests` | Deterministic tests that match the project's existing style |

Turn individual ones off in **Settings → Integrations → Skills**. Only enabled skills appear in the picker.

Some skills are model-invocable and some are not. A skill marked otherwise can only be run by you typing it, so the model cannot decide on its own to enter caveman mode.

## Installing more

**Settings → Integrations → Skills → Skills Library** browses curated third-party packs: **Matt Pocock**, **Addy Osmani Agent Skills**, **Superpowers**, **last30days** and **Browserbase**. Install a whole pack or pick individual skills. You can also install directly from a GitHub URL.

Each pack is pinned to a specific commit rather than tracking a branch, so an install is reproducible and cannot change under you. Downloads are restricted to GitHub hosts. Installs land in `skills/` in your Minnow home, record where they came from, and are enabled immediately.

Browsing works offline — Minnow ships an index of each pack's contents. Installing needs a network.

## Writing your own

Create a folder in `skills/` under your Minnow home with a `SKILL.md` inside:

```markdown
---
name: release-notes
description: >-
  Draft release notes from the git log since the last tag. Use for /release-notes.
disable-model-invocation: true
---

# Release notes

1. Run `git log <last-tag>..HEAD --oneline`.
2. Group commits into Added / Changed / Fixed.
3. Write one user-facing line per entry. No commit hashes, no internal ticket ids.
4. Call out anything that breaks compatibility under its own heading.
```

Then enable it in the Skills catalog. A user skill wins over a built-in of the same name, so you can override a shipped skill by shadowing it.

## `/goal`

`/goal <condition>` tells the chat to keep working until something is actually true — not until the model feels finished.

After each turn a separate evaluator agent checks the condition against the code and test results, then either confirms it or sends the chat back to work. It is the difference between "I have fixed the tests" and tests that pass.

- `/goal all tests in test/orchestrator pass`
- `/goal clear` stops the loop (`stop`, `off` and `reset` also work)

The goal persists on the chat across reloads. Bind a capable model to the evaluator role in **Models → Routing → Goal evaluator** — a weak evaluator will happily rubber-stamp a broken build.

## `/loop`

`/loop` re-runs a prompt on a schedule while Minnow is open and the chat is idle.

| Form | Behaviour |
|------|-----------|
| `/loop 5m <prompt>` | Fixed interval. Units `s` `m` `h` `d`; anything under a minute rounds up to one. |
| `/loop <prompt>` | Self-paced — Minnow picks a delay from 1 to 60 minutes based on how much the output is changing. |
| `/loop` | Maintenance mode: runs the checklist in `.minnow/loop.md` in your workspace, or a built-in one. |

The chat panel shows a countdown with pause, resume, skip, interval edit and stop. Loops expire after seven days.

A global ticker wakes at each loop's stored due time, so a reload or a laptop sleep does not lose the schedule.

`/goal`, `/loop` and `/followup` are mutually exclusive on one chat, and `/clear` clears all three.

**`/loop` is not the Scheduler.** A loop lives in one chat, keeps its context, and needs that chat idle. A [Scheduler](../apps/scheduler.md) job is a headless run in a chosen workspace with a chosen model, independent of any conversation. Iterating on something belongs in a loop; a nightly report belongs in the Scheduler.

## `/followup`

`/followup` hands the work on to a **new chat** instead of continuing this one. The new chat opens with a context summary of the chat before it plus the task it exists to do, so nothing has to be re-explained.

| Form | Behaviour |
|------|-----------|
| `/followup` | One follow-up; the agent picks the task from this chat's context |
| `/followup <prompt>` | One follow-up with the task you give it |
| `/followup <n>` | `n` follow-ups in a chain; the agent picks each task |
| `/followup <n> <prompt>` | `n` follow-ups; yours is the first task, the agent picks the rest |

`/followup 5 review the build for bugs and fix them` starts with the bug review, then hands off four more times — each link choosing the next task from what the link before it did. Chains stop at ten links.

The first follow-up opens in front of you because it is your own next task. Later links arrive in the sidebar with an unread dot, so a long chain does not keep pulling the window away. The chat panel shows how many links are left and has a **Stop chain** button; `/followup stop` does the same. Arming a chain never sends anything to the model, and it is safe to type while the current reply is still running.

A chain is stored on its chat, so it survives a reload or a restart: quit with a link pending and it fires when Minnow comes back.

The agent-chosen tasks use the model bound in **Models → Routing → Utility tasks**.

## `/compact`

`/compact` folds older turns of the chat into a summary now, instead of waiting for the window to fill. The last couple of turns stay word for word, and nothing is deleted from the transcript. Text after the command tells the summary what to keep: `/compact keep the schema decisions`. `/compress` and `/summarize` are aliases. See [Context, memory, and rules](../concepts/context-and-memory.md).

## Related

- [Working in chat](chatting.md)
- [Modes](../concepts/modes.md)
- [Scheduler app](../apps/scheduler.md)
- [Settings app](../apps/settings.md)
