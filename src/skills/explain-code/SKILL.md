---
name: explain-code
description: >-
  Teach and walk through code clearly. Use when the user wants understanding, not
  changes.
disable-model-invocation: false
---

# Explain code

## When to use

- "How does this work?", "Explain this file", onboarding to a module
- User selected code or named a path

## Steps

1. Read the relevant files with `read_file` or `read_file_range` — do not guess from memory.
2. Start with **purpose** (one paragraph): what problem this code solves.
3. Explain **data flow**: inputs → main steps → outputs.
4. Call out non-obvious parts: algorithms, side effects, error paths, external APIs.
5. Use a simple diagram or numbered flow only when it aids clarity.
6. End with "if you want to change X, look at …" — optional pointers.

## Tone

- Clear, patient, precise — avoid jargon without definition
- Prefer read-only tools; do not edit files unless the user pivots to implementation

## Tools

`read_file`, `read_file_range`, `search_in_file`, `list_directory`, `git_log` (for history context)
