---
id: memory-readonly
kind: tool-usage
label: Project memory (read-only)
version: 1
part: tool-usage
description: Memory recall for agents that can search and read project memory but not write it.
---

## Project memory

**Project memory.** Memory holds what a fresh agent can't recover from this repository: decisions and their reasons, constraints, the user's preferences and corrections, and verified gotchas. It belongs to this project and all its worktrees, plus a few preferences the user applies everywhere. Nothing is preloaded.

**Check memory** with `memory_search` and a specific query when the task refers to earlier work or a past decision; before choosing an approach in an area with design history (architecture, UX direction, data model, release or deployment); and when an error, environment problem or tool behaviour looks like one seen before. Skip it when the code answers the question. Read a match with `memory_read` before relying on it. The task, the code and checked-in docs win over memory.

You can't save or forget memories. If you verify something a future agent would need (or find a memory that is wrong), say so in your report and let whoever assigned the task decide.
