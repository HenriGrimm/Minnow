# Context, memory, and rules

A model has no memory. Every turn, Minnow rebuilds everything it knows from scratch and sends it. Understanding what goes into that rebuild is the difference between an assistant that seems sharp and one that seems to have early-onset amnesia.

Three separate mechanisms feed it, and they solve different problems:

| Mechanism | Question it answers | Lives |
|-----------|---------------------|-------|
| **Context window** | What is in this conversation right now? | In the request, rebuilt every turn |
| **Memory (Brain)** | What did we establish, days ago? | On disk, retrieved when relevant |
| **Rules** | What must always be true of your behaviour? | On disk, injected every turn |

## The context window

The ring beside **Send** shows how much of the model's window this conversation occupies. Click it for the breakdown.

The breakdown separates **context used** (the latest request’s prompt and reply, plus pending input) from **session usage** (tokens across all recorded requests, including tool rounds and the chat title). Each tool round sends history again, so session usage can greatly exceed the context size. Cached input may have a different price; token totals are not a bill.

Everything competes for that space: the system prompt, your standing rules, retrieved memories, the tool definitions your mode allows, the whole conversation so far, and every tool result. A single large file read can cost more than an hour of conversation.

If the ring shows no cap, the model did not report a context length. Minnow will not invent one.

**Symptoms of a full window** are distinctive: the model forgets a constraint you set earlier, repeats work it already did, or starts answering a version of your question from ten messages ago. Fixes, in order of how much they cost you:

1. Start a new chat for the new subtask. Cheapest and usually right.
2. Remove large attachments you no longer need.
3. Move the durable facts into Brain, then start fresh — the facts come back through retrieval instead of scrollback.
4. Switch to a larger-context model.

The ring is a guide, not a wall. Some providers truncate silently when you overflow and some fail outright.

**Tool result size** is a different setting. Settings → Integrations → Tools caps how much text each file read, search, or shell command **returns in the first place**. Context policy only acts on history that is already in the chat. See [Tools and permissions](tools-and-permissions.md).

### Context policy for agents

Agents that run unattended — board tasks, sub-agents, scheduled jobs — cannot ask you to start a new chat, so they need a rule for what to do when they hit their cap. **Settings → Agents → Context policy** sets the global default:

| Policy | What happens at the cap |
|--------|-------------------------|
| **Summarize** | Dropped turns are compressed into a "Prior context" block. The default. |
| **Slide** | Oldest turns fall off the front. |
| **Truncate** | Hard cut. |
| **Archive** | Older turns are set aside and retrieved when relevant. |

Individual work agents and sub-agent types can override it, or inherit the global default. Enforcement only happens when that agent has a max-input-token cap set; with no cap there is nothing to enforce against.

## Memory

Memory in Minnow is not a hidden vector blob. It is **Brain** — a real wiki of markdown pages in your Minnow home that you can open, read, edit and delete.

When memory is on, Minnow retrieves relevant pages before a turn and injects them into the prompt. Defaults: semantic embeddings enabled, up to 12 hits retrieved, roughly 500 characters of query-relevant excerpt per hit rather than a generic preview, capped at about 8,000 characters injected on the full prompt profile. Retrieved content is fenced as untrusted data, the same as a web page.

### Saving a memory

Three ways:

- **Ask.** "Remember that we deploy on Fridays" — the model calls `save_memory`, which defaults to Full permission.
- **Write a page yourself** in Brain → Edit.
- **Let synthesis propose one.** Minnow can suggest memories from your conversations; they queue in Brain → Proposals for review rather than landing silently.

Every individual save raises a small review card for ten seconds with the title and an excerpt. It has **Reject**, which deletes the page, and **Open memory**, which takes you to it. Hovering pauses the timer. If the model saves something wrong, you find out immediately instead of a week later when it confidently repeats it.

### What belongs in memory

Good: durable decisions and their reasons, conventions, names and roles, environment quirks, "we tried X and it failed because Y".

Bad: transcripts, anything that changes weekly, secrets. Memory is retrieved into prompts — including prompts sent to a cloud provider if that is what you are using.

Managing it is in [the Brain app](../apps/brain.md): browse the graph, edit pages, run **Lint** to find orphans, stale pages, broken links and contradictions.

## Rules

Rules are standing instructions injected into every system prompt. "Always use TypeScript strict mode." "Never commit without running tests." "Answer in British English."

**Settings → Agents → Rules.** Rules are off by default and organised into groups you can enable or disable together — a "Work" group and a "Personal" group, say, without rewriting the text each time. Empty groups can be deleted from that page. A group that still has rules stays until those rules are moved or deleted.

Keep them short and testable. Rules cost context on every single turn, so a page of them is a page you pay for constantly. If something applies to one project only, a memory page is usually better than a global rule.

## Prompt profiles

**Settings → Agents** exposes prompt profiles: **Full** for maximum guidance, **Lite** for a much smaller system prompt, or a custom profile of your own. Lite is worth trying with small local models, where the system prompt can be a serious fraction of the window. The section shows a live token estimate as you change it.

Setup profiles bundle prompts and tool configuration together so you can export a working configuration and import it elsewhere.

## Recall

Two tools let the model reach back into its own history without you pasting: `recall_chat_context` and `recall_turn_full`. They matter after context has been compacted — the model can retrieve the actual earlier turn instead of relying on a summary of it.

## Related

- [Brain app](../apps/brain.md)
- [Working in chat](../chat/chatting.md)
- [Modes](modes.md)
- [Agents, sub-agents, and packs](../orchestrate/agents.md)
