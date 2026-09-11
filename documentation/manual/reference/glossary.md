# Glossary

Terms Minnow uses, in the sense Minnow means them.

**Running** — The board is ticking: eligible work starts up to the concurrency cap until you press Stop or the board finishes.

**Board** — A kanban of tasks generated from a plan document, worked by agents. See [Orchestrate boards](../orchestrate/boards.md).

**Brain** — Your own knowledge wiki: markdown pages in your Minnow home that the assistant reads and writes. Minnow's memory system. Not this manual.

**Composer** — The input area: text field, mode strip, attachments, tools, microphone, model picker, context ring, send.

**Context policy** — What an agent does when it hits its input cap: summarize, slide, truncate or archive.

**Context ring** — The dial beside Send showing how much of the model's window this conversation uses.

**Concurrency** — How many board tasks may start at once. Sequential is Running at 1.

**Fixer** — The board role that repairs a task after its tests fail.

**Goal** — A completion condition set with `/goal`. A separate evaluator agent checks it after each turn.

**Integration branch** — The branch a board merges completed task work into, when worktree isolation is on.

**Isolation** — Giving board tasks their own git worktrees so parallel agents do not collide. Off, per-task, or per-wave.

**Loop** — A prompt re-run on a schedule in one chat, set with `/loop`. Different from a Scheduler job.

**MCP** — Model Context Protocol. A standard for exposing tools; MCP tools appear as `mcp__<server>__<tool>`.

**Minnow home** — The folder holding everything Minnow keeps: `%USERPROFILE%\.minnow` or `~/.minnow`.

**Mode** — What the assistant is allowed to be this turn. Changes the system prompt and the tool list. General, Build, Plan, Debug, plus surface-bound ones.

**Plan document** — Markdown under `documentation/plans/`. The one place Plan mode may write, and the input a board executes.

**Provider** — An OpenAI-compatible endpoint Minnow talks to: a local runtime, a served model, or a cloud API.

**Quarantine** — A board task parked after exhausting its retries, along with its dependents. Cleared with Requeue.

**Routing** — Binding different models to different jobs — main chat, chat titles, goal evaluation, each agent role.

**Skill** — A `SKILL.md` file of packaged instructions, invoked with `/`.

**Sub-agent** — A nested agent spawned for one job, running in the background and reporting a structured result.


**Tool** — A function the model can call. Every one is Off, Ask or Full.

**Wave** — A dependency group on a board. Tasks in one wave can run in parallel; the next wave waits.

**Work agent** — A role with its own prompt, sampler and optional model: builder, planner, reviewer, researcher and others.

**Workspace root** — The folder file and git tools are confined to. Set by the project you open in Code, or **Sandbox** (`~/.minnow/workspace`) when you have not picked a repo yet.

**Legacy routes** — `#/workspaces` is the workspace gate (same as `#/`, `#`, and `#/desktop` after [`resolveLegacyHash`](../../../src/os/router.ts)). `#/app/chat` redirects to Code chat (`#/app/code/chat`). Legacy `#/bugs` opens Issues (`#/app/issues`).

**Worktree** — A separate git checkout of the same repository. Board isolation uses one per task so agents do not collide on a single working tree. That is git isolation, not OS host containment — see the agent shell sandbox under [Privacy and security](privacy-and-security.md).

## Related

- [How Minnow works](../concepts/how-minnow-works.md)
- [Minnow manual](../README.md)
