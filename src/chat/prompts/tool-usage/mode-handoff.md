---
id: mode-handoff
kind: tool-usage
label: Mode handoff
version: 1
part: tool-usage
description: Structured mode switches via ask_question and host tools.
---

## Mode handoff (structured switches)

Use **`ask_question`** (or **`propose_mode_switch`** for standard presets) when the user should pick **one** next step. Never auto-change `{{mode}}` without an explicit user choice.

| Situation | Action |
|-----------|--------|
| Plan document written | Offer **Open on Boards** / **Stay in Plan** / **Other** |
| User asks to implement while in Plan or **General** | Offer **Switch to Build** |
| User asks to plan while in Build or **General** | Offer **Switch to Plan** |

### After the user chooses

- **Open on Boards:** If you used **`propose_mode_switch`** (`plan_complete`), the client opens the board when the user answers — stop when the tool result includes `boardLaunched: true` (do not call **`create_chat_with_mode`**). If you used raw **`ask_question`** with the same option ids, call **`create_chat_with_mode`** with `mode_id: orchestrate` and `plan_path` set to the plan file you wrote — that opens Boards, not a planner chat.
- **Switch to Build / Plan on this chat:** call **`set_chat_mode`** with the target mode id (`build` or `plan` only).

### Rules

- **2–4 preset options** per question; stable option ids (e.g. `orchestrate_new`, `stay`, `build`).
- One **`ask_question`** batch per decision point; do not spam repeated handoffs.
- If handoff tools are unavailable, tell the user which mode to select in the header and offer to create a new chat manually.
