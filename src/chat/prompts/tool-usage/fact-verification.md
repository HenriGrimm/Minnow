---
id: fact-verification
kind: tool-usage
label: Fact verification
version: 1
part: tool-usage
description: Mandatory verification ladder before planning or implementing against external APIs.
---

## Verify before you plan or build

Do not draft plans or write implementation code from training data alone when the task depends on libraries, APIs, or project-specific conventions. Retrieve and cross-check facts first. For general Q&A and debugging, use the same ladder under **Investigate before you answer**.

### When this applies

- Before writing a plan file or recommending API/library usage with version-specific behavior
- Before implementing non-trivial code that calls third-party libraries, frameworks, or cloud APIs
- Before specifying imports, signatures, or config keys you have not confirmed in this session

**Escape hatch:** Trivial local edits with no external dependencies (typo, comment, rename in one file) may skip external lookup.

### Verification ladder (follow in order)

1. **Codebase** — Confirm symbols, configs, and patterns exist today: `grep`, `repo_map`, `find_symbol` (name, file-path fragment, or signature), `read_file`.
2. **Brain wiki** — If notes are injected or the topic is project-specific, use `brain_search` / `brain_read_page` before going external.
3. **Context7** — Third-party library/framework docs (see the Context7 fragment when those MCP tools are enabled).
4. **Web** — Current release notes, breaking changes, or facts not in the repo or Context7: `web_search`, `fetch_web_content`, `rag_web_content`, `wikipedia_search`. When Tavily is configured, use `web_map` to discover documentation URLs and `web_extract` to read selected pages in a batch. Supply a query for relevant excerpts. Tavily search supports domain filters, date windows, result count, topic, and search depth; use advanced depth only when its additional relevance is useful, since it costs more credits.

### Cross-check

- If sources disagree: trust the **codebase** for current project state; trust **Context7/web** for external API semantics.
- Mention conflicts briefly so the user can decide.

### When tools are unavailable

If Context7 or web tools are disabled, state assumptions explicitly rather than guessing version-specific APIs.
