---
name: write-tests
description: >-
  Generate deterministic tests matching project style. Use when adding or fixing
  test coverage.
disable-model-invocation: false
---

# Write tests

## When to use

- User asks for unit/integration tests for a module or bug fix
- After implementing behavior that lacks coverage

## Steps

1. Discover test stack: read `package.json` scripts, existing `test/` files, and one representative test file.
2. Match **framework and style** (e.g. `node:test`, Vitest, pytest) — do not introduce a new runner without asking.
3. Use **fixed fixtures**: hardcoded ids, dates, and expected strings — no `Date.now()` or random UUIDs in assertions.
4. Prefer **static expected output** (full JSON/string) over building expectations in code.
5. Cover: happy path, one failure/edge case, and boundary if relevant.
6. Run the project's test command (`execute_command` or documented npm script) and fix failures.

## Principles

- Tests document behavior; name tests by scenario (`rejects empty input`)
- Assert business outcomes, not private implementation details
- Minimal mocking; prefer real small fixtures

## Tools

`read_file`, `list_directory`, `find_files`, `search_in_file`, `save_file`, `execute_command`
