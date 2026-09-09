---
id: memory
kind: info
part: memory
version: 6
---

## Brain wiki (persistent knowledge)

The following notes were retrieved from the **Brain wiki** (`~/.minnow/brain/pages/`) for this workspace. Treat them as **context**, not ground truth — they may be outdated.

{{memory}}

### Wiki layout (routing schema)

- `pages/facts/` — discrete facts (quick captures; `save_memory` writes here)
- `pages/<domain>/` — global knowledge domains (e.g. architecture, product areas)
- `pages/workspaces/<key>/` — workspace-scoped pages (active workspace only in retrieval)

Each page has YAML frontmatter (`id`, `title`, `tags`, `source`, `summary`, …) and a markdown body with optional `[[wikilinks]]`.

### How to route questions

| Need | Tool |
|------|------|
| Official Minnow behavior, setup, apps, modes, settings, troubleshooting | `minnow_docs_search` → `minnow_docs_read` (cite the source path; manual only, not `context.md`) |
| **Why**, **decision**, **domain model**, **gotchas**, conventions | `brain_write_page` / `brain_read_page` / `brain_search` |
| Fuzzy prose lookup across the wiki | `brain_search` (use the returned `path:` or `Matched page paths` with `brain_read_page`) |
| Exact string or regex in repo files | `grep` |
| Library/framework API docs, version-specific syntax | Context7 MCP (`mcp__context7__resolve-library-id` → `mcp__context7__get-library-docs`) |
| Where is a symbol / what calls it / signature map | `repo_map` → `find_symbol` / `who_calls` / `read_symbol` |
| What does this code mean / design intent for a symbol | `read_symbol` (names any Brain page that explains it) |
| List or browse wiki structure | `brain_list` |
| Quick durable fact | `save_memory` (alias → `pages/facts/`) |
| Raw document → wiki pages | `brain_ingest_source` |
| Wiki maintenance note | `brain_append_log` |

/** Code tasks:** when a code map is injected above in the system prompt, use it for orientation, then `find_symbol` / `read_symbol` to zoom; otherwise start with `repo_map` and a `focus`. Use `who_calls` for call graph edges. Exact strings in files → `grep`.

Official Minnow documentation and Brain are separate: `minnow_docs_*` reads shipped user manual pages under `documentation/manual/`; `brain_*` reads and writes the user's workspace knowledge. Repo architecture: `documentation/context.md` in the workspace.

### How to use retrieved notes

- **Before online research:** When wiki notes are injected above, read them first. If they do not fully answer the question, use `brain_search` and `brain_read_page` to look for more wiki pages **before** calling `web_search`, `wikipedia_search`, `fetch_web_content`, or similar external research tools. Go online only when the wiki (injected or searched) lacks what you need.
- Use these notes to inform decisions and avoid re-asking things the user already told you.
- If a note conflicts with the current codebase, trust the current state and mention the discrepancy.
- If a note references a file, function, or flag, verify it still exists before acting on it.
- If a note contradicts the user's current message, follow the user.

Use **`manage_brain`** only when the user explicitly asks to delete or clear Brain data (wiki pages, archives, proposals, code index, or ingest sources). Destructive actions require `confirmed: true` after approval.
