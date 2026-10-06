# Brain

Brain is Minnow's memory, and it is not a black box. It is a wiki of markdown pages in a folder on your disk that you can read, edit, delete and back up. The assistant searches and writes it with tools; you curate it.

Open it from the app rail. It fills the main stage like the other rail apps.

Brain is **not** this manual. The manual ships with the build and is read-only; Brain is yours. See [Wiki and Brain](../reference/wiki-and-brain.md).

## The sections

| Section | What it is for |
|---------|----------------|
| **Graph** | The home view — pages, tags and wikilinks on an interactive canvas |
| **Edit** | Create or update a page: frontmatter plus a markdown body |
| **Log** | A read-only changelog of what has been written |
| **Schema** | The wiki's taxonomy — the shape pages are expected to follow |
| **Proposals** | AI-suggested memories waiting for your review before they become pages |
| **Memories** | The memory store: turn it on, manage entries, control what gets injected |
| **Ingest** | Hand Minnow a raw source and let it synthesize pages from it |
| **Lint** | AI cleanup planner: scan the wiki, review a model-written plan, run approved fixes |
| **Code** | The indexed repo map — search symbols, inspect call graphs |
| **Settings** | Embeddings, synthesis cadence, code index options |

Memory settings live here, not in the main Settings app. Searching "memory" in Settings deep-links you into Brain.

## How things get in

**You write them.** Brain → Edit. Frontmatter and markdown. Nothing clever.

**You ask the assistant to.** "Remember that the staging database resets nightly." The `save_memory` tool defaults to Full permission, so it just happens.

**Synthesis extracts them.** Minnow can watch conversations on a cadence you set. With the shipped defaults, facts below 0.6 confidence are skipped; facts from 0.6 up to 0.85 queue in **Proposals** for review; facts at or above 0.85 are saved directly and raise the post-save review card. Brain → Settings lets you adjust the auto-write confidence threshold.

To require review for every eligible synthesis fact, set `requireConfirmation: true` through the local authenticated `PUT /api/memory/synthesis/config` API, with JSON body `{"requireConfirmation":true,"autoWriteConfidence":0.85}`. This setting has no checkbox in Brain Settings. Setting the auto-write threshold to 1 alone still allows a confidence-1 fact to be saved directly. The confidence floor still applies when confirmation is required.

**You ingest a source.** Paste or point at raw material and let the utility model turn it into structured pages. Good for meeting notes, a spec, a long email thread.

Whichever route, an individual save raises a ten-second review card with the title and an excerpt, plus **Reject** (which deletes it) and **Open memory**. Wrong memories are caught immediately rather than discovered later, mid-answer.

## How things come out

On the first user turn of a chat, when memory is enabled, Minnow retrieves relevant pages and saves their excerpts with the chat. Later turns replay that saved snapshot; edits to Brain do not automatically refresh it. For current notes in an existing chat, ask the assistant to use `brain_search` and `brain_read_page`, or start a new chat to refresh automatic retrieval.

Retrieval is hybrid — keyword plus semantic vectors, with embeddings on by default. Roughly 12 hits, with a query-relevant excerpt from each rather than a generic first line, capped at about 8,000 characters injected on the full prompt profile.

The Edit section keeps unsaved drafts when you open another page or choose New. Opening the original page restores its draft while the app stays open. Reload asks before discarding edits; save drafts before closing or restarting Minnow.

Retrieved content is fenced as untrusted data, the same as a web page.

The agent tools, if you want to know what the model is doing: `brain_search`, `brain_read_page`, `brain_list`, `brain_write_page`, `brain_append_log`, `brain_ingest_source`, `manage_brain`, plus `save_memory`.

## The code index

**Brain → Code** is a symbol index of your repositories, and it is what makes the model's code questions fast and grounded rather than grep-and-hope.

Once a workspace is indexed, these tools work: `repo_map` for structure, `find_symbol` to locate a definition, `who_calls` for callers, `read_symbol` to pull one function without the file around it (naming any Brain page anchored to it). All default to Full permission.

The index is per workspace and lives in your Minnow home.

## Keeping it healthy

A wiki nobody prunes becomes a wiki nobody trusts. **Lint** helps you fix that without guessing.

1. **Generate plan** — Minnow scans your wiki read-only (orphan and stale pages, broken wikilinks, code anchor drift, and weak `similarTo` links). It uses the **model in the top bar** (same picker as chat) to draft a markdown cleanup plan plus summary chips (deletes, merges, link fixes, and so on).
2. **Review** — Read the plan before anything changes. The planner is conservative; destructive steps should cite evidence in the plan text.
3. **Run cleanup** — After you confirm, a server agent executes only that plan (edits, merges, link fixes, pruning weak links, anchor drift handling). A live log shows progress; when it finishes, check **Graph** for the updated wiki.

You need the Minnow tool server running and a model selected in the top bar. Run this occasionally. A small accurate Brain beats a large stale one.

For scripted lint (including optional contradiction detection) without the planner UI, the server still exposes `POST /api/brain/lint` for automation and tests.

## What belongs here

Good: decisions and the reasoning behind them, conventions, who does what, environment quirks, "we tried X, it failed because Y", project glossaries.

Bad: transcripts, anything that changes weekly, secrets. Brain content is injected into prompts — including prompts to a cloud provider, if that is what you use.

## Your data

Everything is under `brain/` in your Minnow home: markdown pages, a catalog cache, vectors, ingested sources and code index databases. Plain files you can grep, diff, or put in a git repository.

If Brain matters to your work, back it up. See [Where your data lives](../reference/configuration.md).

## Related

- [Context, memory, and rules](../concepts/context-and-memory.md)
- [Wiki and Brain](../reference/wiki-and-brain.md)
- [Where your data lives](../reference/configuration.md)
