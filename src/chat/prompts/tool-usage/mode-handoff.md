---
id: mode-handoff
kind: tool-usage
label: Mode handoff
version: 1
part: tool-usage
description: Structured mode switches via ask_question and host tools.
---

## Mode handoff (structured switches)

Use **`ask_question`** (or **`propose_mode_switch`** for standard presets) when the user should pick **one** next step. Never auto-change `{{mode}}` without an explicit user choice. After a plan file is written, do not ask about next steps — the client shows Open plan / Build here / Orchestrate buttons.

| Situation | Action |
|-----------|--------|
| User asks to implement while in Plan or **General** | Offer **Switch to Build** |
| User asks to plan while in Build or **General** | Offer **Switch to Plan** |

### After the user chooses

- **Switch to Build / Plan on this chat:** call **`set_chat_mode`** with the target mode id (`build` or `plan` only).

### Rules

- **2–4 preset options** per question; stable option ids (e.g. `orchestrate_new`, `stay`, `build`).
- One **`ask_question`** batch per decision point; do not spam repeated handoffs.
- If handoff tools are unavailable, tell the user which mode to select in the header and offer to create a new chat manually.
