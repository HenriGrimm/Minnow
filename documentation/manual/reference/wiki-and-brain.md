# Wiki and Brain

Minnow has two knowledge surfaces and they get confused constantly, because both answer questions and both look like wikis. The difference is simple: **one is about Minnow and you cannot edit it; the other is about your work and it is entirely yours.**

## The short version

| | Minnow wiki | Brain |
|---|-------------|-------|
| **Open with** | The menubar **?** | The Brain app in the dock |
| **Contains** | This manual, for your installed version | Your facts, decisions, notes, code index |
| **Editable** | No | Yes |
| **Written by** | The Minnow build | You and the assistant |
| **Ask it** | "How does the Scheduler work?" | "What did we decide about auth?" |

## The Minnow wiki

The manual you are reading. It ships inside the build, so it always matches the version you have installed — no version-skew between the app and its documentation.

- Grouped navigation on the left, in reading order.
- Full-text search across every page. **Ctrl+K** / **Cmd+K** focuses it.
- Deep links reload to the same page.
- An "On this page" contents list on wide screens.
- A footer link to edit any page on GitHub, if you want to fix something.

It is an overlay, not an app. Opening it does not disturb whatever you were doing; closing it puts you back.

Developer material — architecture, setup from source, contributing — is deliberately not in here. It lives on the [GitHub Wiki](https://github.com/HenriGrimm/Minnow/wiki).

## Brain

Your wiki: markdown pages in your Minnow home, with a graph view, an editor, ingest, lint and a code-symbol index. The assistant searches and writes it with tools. `save_memory` writes here.

This is where "we deploy on Fridays" and "the staging database resets nightly" belong. Retrieval pulls the relevant pages back into the prompt when they matter, which is how the assistant appears to remember across conversations.

See [the Brain app](../apps/brain.md) and [Context, memory, and rules](../concepts/context-and-memory.md).

## Asking chat about Minnow

Every chat can load three read-only tools for this manual:

| Tool | Does |
|------|------|
| `minnow_docs_search` | Finds pages and returns excerpts |
| `minnow_docs_read` | Opens a page |
| `minnow_docs_list` | Browses the catalog |

They are reads, so they never ask, and they work regardless of your workspace or Brain settings. Ask "how do I point Minnow at Ollama?" and you get an answer citing a page rather than a guess.

The prompts are deliberate about the split: Minnow product questions go to the manual, your project knowledge goes to Brain, and repository architecture comes from reading the repository.

## The GitHub Wiki

A public mirror of the full documentation set — this manual plus contributor and maintainer material — published from the repository. Useful when you want to read documentation without opening Minnow, or link someone to a page.

It mirrors the repository, not your Brain. Nothing of yours is published.

## Which one do I want?

| Question | Surface |
|----------|---------|
| How does an orchestrate board work? | Minnow wiki, or ask in chat |
| What is the shortcut for the terminal? | Minnow wiki → [Keyboard shortcuts](keyboard-shortcuts.md) |
| Why did we choose Postgres? | Brain |
| What is our release date? | Brain, or Issues |
| Turn these meeting notes into something I can search | Brain → Ingest |
| How do I set up a language server? | Minnow wiki → [Integrations](../extend/integrations.md) |

## Related

- [Brain app](../apps/brain.md)
- [Context, memory, and rules](../concepts/context-and-memory.md)
- [Minnow manual](../README.md)
