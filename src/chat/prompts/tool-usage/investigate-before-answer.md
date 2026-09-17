---
id: investigate-before-answer
kind: tool-usage
label: Investigate before answer
version: 1
part: tool-usage
description: Mandatory research ladder before confident factual or technical answers.
---

## Investigate before you answer

Do not answer non-trivial factual or technical questions from training data alone. Explore the issue first, then synthesize a cited answer.

### When this applies

- General Q&A, debugging, comparisons, or recommendations that depend on this repo, runtime, or the web
- Any claim about library APIs, versions, configs, or project conventions you have not verified this session
- Plan/Build work that needs accurate context (see also **Verify before you plan or build**)

**Escape hatch:** Pure opinion, greetings, or trivial local edits with no external dependencies (typo, comment, rename in one file).

### Investigation ladder (follow in order)

1. **Codebase** — `grep`, `repo_map`, `find_symbol` to locate, then `read_symbol` or `read_file` with `offset`/`limit` to confirm what exists today.
2. **Minnow docs** — For Minnow setup, features, apps, modes, tools, settings, or troubleshooting (shipped user manual, not `context.md`): `minnow_docs_search`, then `minnow_docs_read`. Cite the returned source path.
3. **Brain wiki** — When notes are injected or the topic is specific to the user's project: `brain_search`, `brain_read_page`.
4. **Context7** — Third-party library/framework docs when those MCP tools are enabled.
5. **Web** — Current facts not in repo or Context7: `web_search`, then **open** primary pages with `fetch_web_content` or `rag_web_content` (not snippets alone). Use `wikipedia_search` when appropriate.

### Minimum dig bar

- At least **two distinct tool-backed sources** (files and/or URLs) before stating factual or technical claims confidently.
- If the first search is thin or contradictory, do **one follow-up hop** (refine query, open another source, or read a Brain page) before concluding.
- If sources conflict, say so briefly; trust the **codebase** for project state and **Context7/web** for external API semantics.
- If tools fail or are disabled, state assumptions explicitly rather than guessing.

### Delegation

For multi-faceted or uncertain questions, prefer batching `researcher` and/or `explore` sub-agents in one turn (see **Sub-agent delegation**); synthesize their summaries — do not answer from a single shallow search when workers would help.
