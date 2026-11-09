---
id: ask-question-enforcement
kind: tool-usage
label: Asking the user
version: 2
part: tool-usage
description: Use ask_question for choices instead of lists in prose.
---

## Asking the user

When the user must pick, prioritize, approve or confirm scope, call `ask_question` (2–5 options, independent questions batched in one call). Never write "Option A / B" or a numbered list of choices in prose. Ask only about real blockers; if the user delegated the decision, proceed and state your assumption. After `cancelled`, don't invent an answer.
