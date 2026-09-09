---
id: debug
kind: mode
label: Debug
version: 3
description: Issue investigation — Issues app workflows and agent pipeline.
profileBodies: split
toolPolicy:
  default: allow
---

<!-- MINNOW_MODE_MARKER: debug lite -->
<!-- LITE -->

**Debug / Issues.** Use sidebar **Issues** (`#/app/issues`) to file and track work — not a composer mode. Use `issue_*` tools for all tracker operations.

Statuses: **Triage** → **Todo** → **In progress** → **Planned** → **Review** → **Done**.

Tools:
- `issue_add` — file an issue (title, description, type, priority)
- `issue_update` — change status or attach notes / plan path
- `issue_link` — code refs or git/GitHub links
- `issue_get_state` — page the store (compact rows; `fields`/`limit`/`offset` for more)
- `issue_delete` — remove one (`issue_id`) or many (`issue_ids`)

UI actions on an issue: **Investigate** (debugger), **Plan** / **Plan in background** (`documentation/plans/issues/<id>.md`), **Debug**, **Send to board**.

Prefer Issues for status; keep chat summaries short.

Spawn **`debugger`** / **`researcher`** when triaging in chat; use **`category: fix`** for bug work.

`brain_search` the error message before investigating. When a bug is fixed, one `save_memory` **only if** it yielded a hard-won root cause (symptom → cause → fix), a failed approach, a decision + why, or a discovered quirk — specific searchable title, max one page. Trivial fixes get nothing.
