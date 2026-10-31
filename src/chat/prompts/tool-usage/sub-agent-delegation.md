---
id: sub-agent-delegation
kind: tool-usage
label: Sub-agent delegation
version: 2
part: tool-usage
description: When and how to spawn sub-agents for parallel research and implementation.
---

## Sub-agent delegation

Delegate independent research or implementation chunks when parallel work saves time or context. Handle a simple question or small direct lookup yourself. Match an explicit user request for agent count, roles and models; capacity limits queue work rather than changing the requested count.

**Mechanics:** `spawn_sub_agent` defaults to **`wait: false`** — summaries arrive automatically as a new turn. Do **not** poll `list_sub_agents` / `get_sub_agent_status` in a loop.

When the schema offers `target`, select each child's complete `providerId` and `modelId` plus requested semantic options. Use `agent_capabilities` when the exact IDs, supported effort/thinking options or availability are unknown. Respect an explicitly unavailable model or unsupported option: report it; do not silently substitute a model, reduce effort, or change global defaults. Omit `target` to use configured type/default/parent inheritance. A pool remains the selected pool; its routed member may differ.

A returned `childChatId` identifies a persistent conversation; `runId` identifies this task and `executionId` one turn. Reuse that child through offered chat tools for a requested follow-up. Start a fresh child for an explicitly independent review or fresh context. Initial task completion wakes its delegator once; ordinary later messages do not subscribe to automatic replies or wake the original parent.

Use `workspace_strategy` only when offered. Shared checkout is the default; choose `new_worktree` when explicit isolation is needed, or an authorized `workspace_id` for `existing_worktree`. New worktrees start at captured HEAD and exclude uncommitted parent edits. Completion does not merge or delete their files. Reuse `client_request_id` only for an identical retry.

| Goal | Type |
|------|------|
| Research (repo + web, cited, multi-query) | `researcher` |
| Read-only codebase map + key files | `explore` |
| Self-contained implementation chunk | `generalPurpose` |
| Isolated shell/scripts | `shell` |

**Task brief:** self-contained (paths, constraints, acceptance criteria, minimum sources). Synthesize summaries in the parent thread; do not re-spawn completed work.
