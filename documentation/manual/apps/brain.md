# Review what agents remember in Brain

Open **Brain** from the command palette. **Memories** shows what agents can recall for the open project, and the preferences you apply to every project.

## How project memory works

- Each project has its own memory. A repository and all its worktrees share one memory, so a chat in a worktree finds what a chat in the main checkout saved. Separate projects never see each other's memories.
- A few memories belong to you rather than a project: preferences you state about how you work, such as how much detail you want in a report. Agents see these in every project.
- Nothing from memory is added to your messages. Agents call `memory_search` when a task calls for it — you mention earlier work, a decision has history, an error looks familiar, or they are about to ask your preference — and read a match with `memory_read` before relying on it. Your current message, the code and checked-in docs take precedence over memory.
- Agents save a memory with `memory_save` only when it will matter later and can't be learned quickly from the code, docs or history: a decision and its reason, a constraint, your preference or correction, or a verified gotcha. They update an existing memory instead of adding a second one, and remove memories that are wrong with `memory_forget`. Saving nothing is the usual outcome of a task.
- Each memory has a kind (decision, constraint, gotcha, preference or reference), a short title and a body of up to 1,200 characters. A project holds up to 150 memories and your preferences up to 40. When a scope is full, agents must update or forget an entry before saving another. Saves that look like credentials are refused.
- Sub-agents and board tasks can search and read memory but not change it; they report anything worth keeping to the agent that started them.

## Review and correct memories

1. Open **Brain → Memories**. The list groups the project's memories and your preferences by kind, with a count against each limit.
2. Select a memory to read its body, evidence and when it was last updated.
3. Choose **Edit** to correct it. If an agent changed it while you were editing, reload and apply your change again.
4. Choose **Forget** to remove a memory that is wrong or no longer applies. Agents stop finding it immediately.

When an agent saves a new memory, a notification appears with **Open memory** and **Reject**. Rejecting removes it.

Turn **Agent memory** off at the top of **Memories** to stop agents searching and saving memory.

For a rule that must always apply, such as a build command or a review policy, put it in `AGENTS.md` or project docs instead of memory.

## Legacy notes and other tools

- **Graph** lists pages from earlier versions of Brain as **Legacy notes**. Agents don't use them. You can still read, edit, link and delete them.
- **Proposals** lists suggested skills from completed conversations. Accept a useful one or reject it. **Brain → Settings** controls when skills are suggested and which embedding model ranks memory search.
- Open **Code** to inspect the workspace's index. Rebuild or refresh it if symbols are missing, then confirm the index belongs to the checkout you are investigating.

For settings and operating instructions for Minnow itself, open the [Minnow manual](../reference/wiki-and-brain.md).
