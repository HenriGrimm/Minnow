---
id: mode-handoff
kind: tool-usage
label: Mode handoff (lite)
version: 1
part: tool-usage
description: Lite mode-switch rules.
---

## Mode handoff

Use **`ask_question`** or **`propose_mode_switch`** for exclusive next steps (never auto-switch mode).

- Plan done → Orchestrate board (`create_chat_with_mode` with plan path) or stay.
- Implement while in Plan → offer Build (`set_chat_mode` → `build`).
- Plan in Build → offer Plan.
