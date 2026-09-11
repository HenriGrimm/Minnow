# Agents, sub-agents, and packs

Minnow does not have one assistant. It has a system of them, and the differences between the kinds matter once you start delegating real work.

| Kind | What it is | Where it runs |
|------|------------|---------------|
| **Work agent** | A role with its own prompt and model binding | The main chat, or a board chat |
| **Sub-agent** | A nested agent spawned for one job, reporting back | In the background |
| **Board member** | A builder, tester or fixer bound to one task | Its own board chat |

## Work agents

A work agent is the *role* the assistant is playing: its system prompt, its sampler settings, its thinking mode, and optionally its own model.

Shipped roles: `default`, `general`, `desktop`, `planner`, `orchestrator`, `builder`, `verifier`, `tester`, `reviewer`, `researcher`, `ui-designer`, `expert-panel`.

Edit them under **Settings → Agents**. The most useful thing you can do there is bind different models to different roles — see [Routing](../apps/models.md#routing). A reviewer that finds real problems is worth a better model than a builder writing boilerplate.

## Sub-agents

A sub-agent runs a job in the background and reports a structured result. Delegation is how a long task avoids drowning your main conversation in exploration: three agents read the codebase in parallel and hand back findings, instead of your context filling with file dumps.

Shipped types:

| Type | For |
|------|-----|
| **General purpose** | Anything not covered by a specialist |
| **Explore** | Reading and searching. Read-only by design — no shell, no commits. |
| **Research worker** | Web and code research; the most parallel type, up to five at once |
| **Shell** | Command execution |
| **Explorer (self-heal)** | Diagnosing a stuck board task |
| **Debugger** | Root-cause investigation |
| **Bug planner** | Turning a diagnosis into a fix plan |
| **Issue writer** | Expanding a triage note into a real issue |

Three at once globally by default, with per-type caps and timeouts. Each type has its own tool allowlist, and **no sub-agent can spawn further sub-agents** — recursion is denied everywhere, which is what stops a delegation cascade.

While a sub-agent runs you see live status — thinking, generating, or the tool it is running — on its card in the transcript and in the drawer. A background agent that finishes while you are elsewhere pushes its result to the parent conversation, so the model has it without a wall of text appearing in your transcript.

Configure them under **Settings → Agents → Sub-agents**: concurrency, timeouts, model bindings, tool allowlists, context policy, and the summary schema each type returns.

### Delegating well

- **Parallel reads, serial writes.** Several explore agents at once is great. Several agents writing to one checkout is not — that is what board worktree isolation exists for (git checkout isolation, not host filesystem containment).
- **Give a clear deliverable.** "Find where authentication is validated and list the files" beats "look into auth".
- **Watch the first one.** If a sub-agent type is misconfigured, you find out in its first run.

## Board members

On an orchestrate board each task gets an agent in one of three roles, with deliberately different tool sets:

| Role | Notable |
|------|---------|
| **Builder** | Full development tools plus browser automation |
| **Tester** | Same, minus the ability to write files — it verifies, it does not fix |
| **Fixer** | Development tools, no browser automation |

All three can read and write Brain, because the worker holds the discovery context: the agent that found the awkward detail is the one that should record it. All three get the composer task checklist. None can change its own mode or reach the mutating board tools; the orchestrator owns board state.

See [Orchestrate boards](boards.md).

## Autopilot

**Settings → Agents → Autopilot** holds the global defaults for board execution: Running or Stopped start, isolation, maximum concurrency, planner model, retries, heartbeat, self-heal rounds, infrastructure provisioning, auto-restart of stalled tasks, and a guard that stops agents changing directory outside their worktree. Isolation here means git worktrees for parallel tasks — it does not sandbox agent shells against the rest of the host (see [Privacy and security](../reference/privacy-and-security.md)).

There is also a **Continue** policy for what happens when a task chat grows too large: always nudge the existing chat, hand off to a fresh chat when a chat is derailed or very large (conservative), or hand off sooner (aggressive).

## Watchdog

**Settings → Agents → Watchdog** sets streaming limits: an **idle timeout** that fires when no tokens arrive, and a **maximum duration** for any single generation.

The idle timeout resets whenever new tokens arrive, so it catches a genuinely dead stream without cutting off a slow model that is still working. This is the setting that stops a hung provider from freezing a board overnight.

## Agent packs

A pack bundles work agents, prompts and configuration into something portable — a house style you can share or reuse.

**Settings → Agents → Agent packs** lets you download a starter template, export the built-in pack as a starting point, upload a pack as a zip, and manage what is installed.

Useful when a team wants everyone's reviewer to apply the same standards, or when you want one configuration on your laptop and your desktop.

## Context budgets

Agents that run unattended cannot ask you to start a fresh chat, so each has a context policy — summarize (the default), slide, truncate, or archive — and optionally a maximum input token cap. Precedence is per-agent override, then the global default, then the shipped default. With no cap set, nothing is enforced.

See [Context, memory, and rules](../concepts/context-and-memory.md).

## Related

- [Orchestrate boards](boards.md)
- [Models app](../apps/models.md)
- [Settings app](../apps/settings.md)
