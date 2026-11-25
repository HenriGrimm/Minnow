---
name: debug
label: Debug
description: >-
  Reproduce, find the root cause, fix and verify a bug; file and update it in
  Issues. Use for errors, failing tests, crashes and wrong behavior.
disable-model-invocation: true
---

## Method

1. **Reproduce** before you theorize. Capture the exact error, command and output.
2. **Narrow** with evidence: read the failing path, add a probe, bisect. One hypothesis at a time.
3. **Fix the cause**, not the symptom. Keep the diff minimal.
4. **Verify** with the same reproduction, then the nearest tests.
5. **Report** the root cause in one or two sentences, what changed, and how it was verified.

# /debug — find the root cause, then fix it

Help the user **file, triage, and fix issues** via the **Issues** app (`#/app/issues`, sidebar **Issues**) and `issue_*` tools for all tracker operations.

## Statuses

| Status | Meaning |
| --- | --- |
| Triage | New or untriaged issue |
| Todo / Backlog | Accepted work not started |
| In progress | Investigation or active fix |
| Planned | Fix plan written under `documentation/plans/issues/<id>.md` |
| Review | Fix ready for review |
| Done / Canceled | Closed |

## Tools

| Tool | Use |
| --- | --- |
| `issue_add` | Create an issue (`title`, `description`, `type`, `priority`) |
| `issue_update` | Change `status`, notes, plan path, run ids |
| `issue_link` | Attach code refs or GitHub/git links |
| `issue_get_state` | Page the issues store (compact rows; pass `fields`/`limit`/`offset` for more) |
| `issue_delete` | Permanently remove one issue (`issue_id`) or many (`issue_ids`) |

## Agent pipeline (Issues detail)

1. **Send to chat** — open the issue in a chat (add `/debug` to investigate).
2. **Plan** — use `/plan` to write `documentation/plans/issues/<id>.md`.
3. **Run factory** on the saved plan to implement it in the chat.

## Ad-hoc sub-agents

Only when the user explicitly requests delegation, spawn a sub-agent with a focused brief (reproduce, bisect, or read a subsystem). Use the saved plan to scope larger fixes.

## Conventions

- Issues persist in `~/.minnow/issues/state.json` (not on chats).
- Plans live at `documentation/plans/issues/<id>.md`.

Cwd: `{{cwd}}`
