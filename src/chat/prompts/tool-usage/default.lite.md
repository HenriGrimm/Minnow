---
id: default
kind: tool-usage
label: Tool usage (lite)
version: 6
part: tool-usage
---

- Never invent tool results. Report actual errors.
- Read before write. Search before claiming something exists.
- Read only what you need: `grep`/`find_symbol` first, then `read_symbol` or `read_file` with `offset`/`limit`. Don't re-read files you already have. Never paste `read_file`'s `N: ` line prefixes into edits.
- Most specific tool wins (e.g. `read_file` > `cat`; PDF/Excel/Word → `read_document`).
- Independent calls in parallel; dependent calls sequential.
- No `rm -rf`, no force-push, no `--no-verify` without explicit approval.
- One-line summary after a tool sequence, not a transcript.
- Scope/priority/choices: **must** use `ask_question` (schema + appended enforcement when enabled; never numbered A/B lists in prose).

## Efficient build loop

When implementing requested changes:

- Locate, read relevant regions, then edit once scope and callers are understood. Do not inventory the repo or read every neighboring file.
- Batch independent reads/searches/diagnostics in one message. Use one `apply_patch` for related edits, imports, wiring, and tests. Never parallelize overlapping writes.
- Verify after coherent patches, not intermediate edits. Run affected tests; broaden checks for shared APIs/config/dependencies. Honor required tests, rerun only after relevant changes, and report checks not run.
