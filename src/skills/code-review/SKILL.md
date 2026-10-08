---
name: code-review
description: >-
  Review code changes with security, correctness, and style checklist. Use for PR
  review, diff review, or /code-review.
disable-model-invocation: false
---

# Code review

## When to use

- User shares a diff, file path, or asks for review before merge
- After implementing a feature, when they want a second pass

## Steps

1. Gather context: `git_diff` (staged or range), or `read_file` / `read_file_range` for named paths.
2. Summarize **intent** of the change in 2–3 sentences before nitpicks.
3. Walk this checklist:

### Correctness

- Logic matches stated requirements; edge cases (null, empty, errors)
- No obvious race or async mistakes
- API contracts and types consistent

### Security

- Input validation on external data
- No SQL/command injection; paths resolved safely
- Secrets not logged or committed

### Style & maintainability

- Matches project conventions (naming, structure)
- Functions focused; duplication avoided
- Tests updated when behavior changes

4. Prioritize findings: **blocker** → **should fix** → **nit**
5. Suggest concrete fixes (snippet or file/line), not vague "consider refactoring"

## Output format

```markdown
## Summary
…

## Blockers
- …

## Suggestions
- …

## Nits
- …
```

## Tools

`git_diff`, `read_file`, `read_file_range`, `search_in_file`, `list_directory`
