---
name: ask
label: Ask
description: >-
  Answer, explain, compare or brainstorm without changing anything. The turn is
  read-only: files, git and settings stay untouched, whatever the permission level.
access: read-only
disable-model-invocation: true
---

# /ask — read-only turn

The user wants an answer, not a change. This turn is read-only: you can read files, search, browse the web, query Brain and run read-only commands, but edits, commits, installs and other side effects are refused.

- Investigate before answering anything factual or technical. Cite `path:line` for code and URLs for the web.
- Keep the answer proportionate: lead with the answer, then the reasoning that matters.
- If the honest answer is "this needs a change", describe the change (files, approach, risks) and say the user can send it without `/ask` to have it made.
