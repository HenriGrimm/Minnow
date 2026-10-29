---
name: ask-user
description: >-
  Gather structured answers from the user with the ask_question tool when requirements,
  scope, or priorities are ambiguous. Use for /ask-user before large plans or multi-feature work.
disable-model-invocation: false
---

# Ask user (structured questions)

## When to use

- Requirements are unclear or conflicting and you need a decision to proceed safely.
- Multiple features or options need prioritization or MVP scope.
- Trade-offs (performance vs simplicity, breadth vs depth) should be explicit before planning.

## How to use `ask_question`

Call with a **`questions`** array. Each item must use **`prompt`** (question text), not `question` or `text`. Each choice is an object **`{ "id": "...", "label": "..." }`** under **`options`** (not `choices`, not plain strings).

| Wrong | Correct |
|-------|---------|
| `"question": "Pick one"` | `"prompt": "Pick one"` |
| `"choices": ["A", "B"]` | `"options": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B" }]` |
| `"options": ["Yes", "No"]` | `"options": [{ "id": "yes", "label": "Yes" }, { "id": "no", "label": "No" }]` |
| `{ "id": "q1" }` only | include **`prompt`** and **`options`** (min 2) |

1. Batch related questions in **one** tool call when possible (up to 10 questions).
2. Each question needs at least **two preset options** with stable `id` values and short `label` text; put any explanation in the `prompt` or option `label` (the tool has no option `description` field).
3. Use **`allow_multiple: true`** only when several non-exclusive answers are valid.
4. The client always adds an **Other** row with free text; do not use option id `__other__` in presets.
5. After the user **cancels**, do not invent answers: ask briefly in chat or state labeled assumptions.

## Make questions easy to answer

- Write for a junior developer by default: plain language, short sentences, and one decision per question. Use more technical language if the user requests it.
- Ask about expected behavior and priorities. Resolve routine implementation details from the workspace instead of asking the user to choose libraries, protocols, or internal components.
- Avoid jargon, acronyms, and file paths. Explain a necessary technical term briefly before asking.
- Describe options by their practical effect. Include a recommended choice with a short reason and its main tradeoff in the question or option labels, so the card makes sense on its own.
- Example: "Should updates appear immediately, or is a short delay okay?" Options: "Immediately — faster updates; more setup (recommended)" and "Short delay — simpler to build" rather than "WebSockets or polling?"

## When not to use

- Facts you can verify from the workspace (`read_file`, search, git status).
- Purely stylistic or trivial preferences unless the user asked for options.

## Mode-handoff presets (`propose_mode_switch`)

When offering **Plan → Orchestrate** or **Build ↔ Plan** choices, prefer **`propose_mode_switch`** with:

| `situation` | When |
|-------------|------|
| `implement_in_wrong_mode` | User wants code in Plan or Research |
| `plan_in_build` | User wants a plan document in Build |

After answers, call **`create_chat_with_mode`** or **`set_chat_mode`** per the mode-handoff prompt rules.

## After answers

Summarize what was chosen in one short paragraph, then continue with the task or plan.
