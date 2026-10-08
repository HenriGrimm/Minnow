---
name: debug-error
description: >-
  Trace tool failures and Error messages systematically. Use when tools fail or the
  user pastes a stack trace.
disable-model-invocation: false
---

# Debug errors

## When to use

- Tool result starts with `Error:` or HTTP failure
- User pastes stack trace, test failure, or "it doesn't work"

## Steps

1. **Reproduce** — identify the exact command, tool call, or user action.
2. **Read the full error** — include stderr, status code, and tool name.
3. **Hypothesis** — one sentence: most likely cause (path, permissions, missing dep, wrong args).
4. **Verify** — use minimal read-only checks (`read_file`, `list_directory`, `get_file_metadata`, `git_status`).
5. **Fix** — smallest change that addresses root cause; explain why.
6. **Confirm** — re-run the same tool or test command.

## Tool-loop patterns

- Path errors → check `resolveSafePath` / project root; use relative paths from repo root
- `git_*` failures → run from project root; check clean/staged state
- `execute_command` timeout → shorten command or increase scope clarity
- Sub-agent errors → check `spawn_sub_agent` args and parent turn id

## Output

- Root cause (factual)
- Fix applied or steps for the user
- How to avoid recurrence (one line)

## Tools

`read_file`, `execute_command`, `git_status`, `list_directory`, `search_in_file`
