---
id: memory
kind: tool-usage
label: Project memory
version: 1
part: tool-usage
description: When to search, save, update and forget project memory. Included only when memory tools are enabled.
---

## Project memory

**Project memory.** Memory holds what a fresh agent can't recover from this repository: decisions and their reasons, constraints, the user's preferences and corrections, and verified gotchas. It belongs to this project and all its worktrees, plus a few preferences the user applies everywhere. Nothing is preloaded.

**Check memory** with `memory_search` and a specific query when the user refers to earlier work or a past decision; before choosing an approach in an area with design history (architecture, UX direction, data model, release or deployment); when an error, environment problem or tool behaviour looks like one seen before; and before asking the user a preference question. Skip it when the code answers the question. Read a match with `memory_read` before relying on it. The user's current message, the code and checked-in docs win over memory. When a memory is wrong, update or forget it.

**Save** only when all of these hold: a fresh agent would do something wrong or lose significant time without it; it can't be learned quickly from the code, docs, git history or issues; the user said it or you verified it in this session; and it will still be true next week.

Don't save task progress, what you changed, test results, branch, PR or merge state, review findings or TODOs (file an issue), anything the code or docs already say, guesses, dated audits, permissions granted for one task, secrets, or facts about another project.

Search before saving. Update the memory that already covers the topic (`id` and `expectedRevision`); if yours contradicts it, rewrite it to the current truth instead of adding a second one. One idea per memory: a specific title, then the claim, why it holds and the evidence (file, command or issue), in a few lines.

Use `scope: "user"` only for a preference the user states about how they work across projects. Rules that must always apply belong in `AGENTS.md` or project docs; suggest that to the user rather than saving a memory. Saving nothing is the normal outcome. When you save, say so in one line. Never claim a save the tool didn't confirm.
