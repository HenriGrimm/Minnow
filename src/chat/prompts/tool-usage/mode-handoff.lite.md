---
id: mode-handoff
kind: tool-usage
label: Mode handoff (lite)
version: 2
part: tool-usage
description: Lite mode-switch rules.
---

## Mode handoff

Use **`ask_question`** or **`propose_mode_switch`** for exclusive next steps (never auto-switch mode).

- Plan done → Orchestrate board (`create_chat_with_mode` with plan path) or stay.
- Implement while in Plan → offer Build (`set_chat_mode` → `build`).
- Plan in Build → offer Plan.
- General → create/revise requested documents (PRDs, specs, RFCs, proposals, reports, notes, guides, written plans) directly with enabled file tools. Do not switch modes for document creation. Offer Plan for a specialized implementation planning workflow; honor explicit requests to use Plan mode.
