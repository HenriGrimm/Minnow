# Planning sub-agent task templates

Pass the filled block as the **`task`** argument to `spawn_sub_agent` with **`wait: true`**.

---

## Research (`explore`)

```text
Role: Read-only research for plan "<plan title>". Do not edit files.

Research questions:
1. <where is X implemented?>
2. <what tests cover Y?>
3. <constraints / gotchas from AGENTS.md area?>

Return:
## Answers (with file paths)
## Suggested phases (rough)
## Risks / unknowns
## Suggested verification commands
```

---

## Research — UI surface (`explore`)

```text
Role: Map UI entry points for plan "<plan title>".

Find:
- Routes / hash paths or Electron-only surfaces
- Relevant components and CSS/token files
- Existing DESIGN.md / --mn-* usage in touched areas
- How to view changes (npm start, Electron shell, MINNOW_BROWSER=1)

Read-only. Return file paths and a short "how to view" section for browser verification.
```

---

## Plan review (`generalPurpose`)

```text
Role: Plan reviewer. Do not edit product code.

Plan file: documentation/plans/<slug>.md

Read the full plan. Evaluate:
1. Locked decisions and non-goals are clear
2. Each phase has in/out scope and concrete verification (commands and/or browser_* steps)
3. Build steps are sequential with Changes/Verify/checklists and shared context; Orchestrate tasks follow the board schema with dependencies and Touches
4. Key files table is plausible — spot-check 3–5 paths exist
5. UI steps have browser verification; only Orchestrate plans need agent handoff instructions
6. context.md / manual updates listed if behavior changes

End with exactly: VERDICT: PASS or VERDICT: FAIL

Return:
## Strengths
## Gaps (actionable)
## Suggested edits (section headings)
## VERDICT: PASS|FAIL
```

---

## Parallel research

When topics are independent, spawn multiple `explore` or `researcher` sub-agents sequentially (`wait: true` each). Merge into one plan **Context** section; dedupe phases.
