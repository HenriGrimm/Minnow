---
id: sub-agent-delegation
kind: tool-usage
label: Sub-agent delegation (lite)
version: 2
part: tool-usage
description: Lite sub-agent spawn rules.
---

## Sub-agent delegation

Delegate useful independent chunks; handle simple tasks yourself. Preserve requested agent counts, roles and models; capacity queues work. `spawn_sub_agent` defaults to `wait: false`; completion is pushed, so do not poll status tools. Types: `researcher` (cited sources), `explore` (read-only map), `generalPurpose`, `shell`. Give self-contained briefs and synthesize results.

When offered, `target` is the complete provider/model pair plus requested options. Discover unknown IDs/options with `agent_capabilities`; report unavailable targets or unsupported effort without silent substitution or global changes. Omit target for inheritance. Keep selected pool identity separate from routed member.

`childChatId` is persistent; `runId` is a task, `executionId` a turn. Follow up in that child; explicitly fresh review/context needs a new child. Ordinary messages do not auto-reply or wake its parent. Shared checkout is default; offered `new_worktree` pins HEAD, excludes dirty parent edits and never auto-merges/deletes. Retry IDs are for identical requests only.
