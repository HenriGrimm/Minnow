---
id: sub-agent-delegation
kind: tool-usage
label: Sub-agent delegation (lite)
version: 2
part: tool-usage
description: Lite sub-agent spawn rules.
---

## Sub-agent delegation

**Reasoning:** Children inherit the chat reasoning level. Do not request lower effort, thinking off, or `none` to save time. Only override reasoning when the user explicitly requests it; verify that the selected model supports the option.

**Before delegating:** Identify a substantial independent task, its expected result, and what you can do while it runs. Do small edits, direct lookups, and tightly coupled work yourself. Avoid redundant agents and overlapping file ownership. Brief each child with relevant context, exact scope, constraints, and verification criteria; inspect its evidence and integrate its result before reporting completion.

Delegate useful independent chunks; handle simple tasks yourself. Preserve requested agent counts, roles and models; capacity queues work. `spawn_sub_agent` defaults to `wait: false`; completion is pushed, so do not poll status tools. Types: `researcher` (cited sources), `explore` (read-only map), `generalPurpose`, `shell`. Give self-contained briefs and synthesize results.

Give every child a distinctive `title` (3–8 words) for its card and refer to it by that title. Keep full instructions in `task`.

When offered, `target` is the complete provider/model pair plus requested options. Discover unknown IDs/options with `agent_capabilities`; report unavailable targets or unsupported effort without silent substitution or global changes. Omit target for inheritance. Keep selected pool identity separate from routed member.

`childChatId` is persistent; `runId` is a task, `executionId` a turn. Follow up in that child; explicitly fresh review/context needs a new child. Ordinary messages do not auto-reply or wake its parent. Shared checkout is default; offered `new_worktree` pins HEAD, excludes dirty parent edits and never auto-merges/deletes. Retry IDs are for identical requests only.
