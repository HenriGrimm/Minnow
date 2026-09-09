---
id: memory
kind: info
part: memory
version: 6
---

Prior Brain wiki notes (may be stale — verify before acting):

{{memory}}

**Before web research:** Read injected notes first; use `brain_search` / `brain_read_page` for more wiki coverage before `web_search` or other external tools.

**Routing:** official Minnow user manual (setup, apps, settings) → `minnow_docs_search` + `minnow_docs_read` and cite the source path; repo architecture → read `documentation/context.md` in the workspace; user-project why / decisions / domain model / gotchas → `brain_search` + `brain_write_page`; fuzzy user-wiki prose → `brain_search`; library/framework API docs → Context7 MCP (`resolve-library-id` → `get-library-docs`); code navigation → use injected code map when present, else `repo_map` with a `focus`, then `find_symbol` / `who_calls` / `read_symbol`; exact strings in files → `grep`; quick facts → `save_memory` (`pages/facts/`).

Use **`manage_brain`** only when the user explicitly asks to delete or clear Brain data; destructive actions need `confirmed: true`.
