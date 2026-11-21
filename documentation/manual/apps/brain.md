# Review what agents remember in Brain

Open **Brain** from the command palette. **Memories** shows what agents can recall for the open project, and the preferences you apply to every project.

## How project memory works

- Each project has its own memory. A repository and all its worktrees share one memory, so a chat in a worktree finds what a chat in the main checkout saved. Separate projects never see each other's memories.
- A few memories belong to you rather than a project: preferences you state about how you work, such as how much detail you want in a report. Agents see these in every project.
- Nothing from memory is added to your messages. Agents call `memory_search` when a task calls for it — you mention earlier work, a decision has history, an error looks familiar, or they are about to ask your preference — and read a match with `memory_read` before relying on it. Your current message, the code and checked-in docs take precedence over memory.
- Agents save a memory with `memory_save` only when it will matter later and can't be learned quickly from the code, docs or history: a decision and its reason, a constraint, your preference or correction, or a verified gotcha. They update an existing memory instead of adding a second one, and remove memories that are wrong with `memory_forget`. Saving nothing is the usual outcome of a task.
- Each memory has a kind (decision, constraint, gotcha, preference or reference), a short title and a body of up to 1,200 characters. A project holds up to 150 memories and your preferences up to 40. When a scope is full, agents must update or forget an entry before saving another. Saves that look like credentials are refused.
- Sub-agents and board tasks can search and read memory but not change it; they report anything worth keeping to the agent that started them.

## Explore memories in the graph

**Brain → Memories** opens on the memory graph. Your project is one hub and **You** (your preferences across all projects) is another. Each hub branches into the kinds it holds — decisions, constraints, gotchas, preferences and references — and each memory hangs off its kind. A dashed line links memories that talk about the same things, and an arrow points from a memory to the older one it replaced.

- Select a memory to read its body, evidence and when it was last updated. Select a hub or a kind to list the memories inside it.
- Double-click a kind or hub to zoom to it; double-click a memory to edit it. Use the zoom buttons or **Fit** to reframe the graph.
- Search filters by title, body and evidence. The project and **You** chips at the top show each scope's count against its limit and hide or show that scope. The legend at the bottom hides or shows a kind.
- Switch to **List** for the same memories grouped by scope and kind.

## Review and correct memories

1. Select a memory in the graph or the list.
2. Choose **Edit** to correct it. If an agent changed it while you were editing, close the editor to load the new version and apply your change again.
3. Choose **Forget** to remove a memory that is wrong or no longer applies. Agents stop finding it immediately.
4. Choose **Add memory** to save one yourself. Pick whether it applies to this project or to all your projects. The same limits, duplicate check and credential check apply as when an agent saves.

When an agent saves a new memory, a notification appears with **Open memory** and **Reject**. Rejecting removes it.

Turn **Agent memory** off at the bottom of the side panel to stop agents searching and saving memory.

For a rule that must always apply, such as a build command or a review policy, put it in `AGENTS.md` or project docs instead of memory.

## Upgrading from the Brain wiki

If your profile contains old wiki data, Minnow recommends cleaning it up after upgrade. **Clean up old Brain data** asks for confirmation before removing old wiki pages, sources and proposals. **Skip** leaves those files on disk. Neither choice removes current Memories, the code index or your backups.

## Other Brain tools

- **Proposals** lists suggested skills from completed conversations. Accept a useful one or reject it. **Brain → Settings** controls when skills are suggested and which embedding model ranks memory search.
- Open **Code map** to inspect the workspace's index. Rebuild or refresh it if symbols are missing, then confirm the index belongs to the checkout you are investigating.

For settings and operating instructions for Minnow itself, open the [Minnow manual](../reference/wiki-and-brain.md).
