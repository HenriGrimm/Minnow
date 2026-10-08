---
name: security-review
description: >-
  OWASP-style security pass on changes or files. Use before merge or for audit
  requests.
disable-model-invocation: false
---

# Security review

## When to use

- Auth, API, file upload, or user-input paths changed
- User asks for security review or `/security-review`

## Steps

1. Identify **trust boundaries**: HTTP APIs, tools, file paths, subprocess, clipboard.
2. Review changed files via `git_diff` or `read_file`.
3. Checklist:

### Injection & execution

- Shell commands: no unsanitized user input in `execute_command`
- File paths: stay under project root unless explicitly allowed
- HTML/JS: no unsanitized user content in DOM (`DOMPurify` where applicable)

### Secrets & data

- No API keys, tokens, or passwords in code or logs
- `.env` and `secrets.json` not committed
- Tool results do not echo env vars

### Access control

- Server routes validate ids (`^[a-z0-9-]+$`) and reject `..`
- User data under `~/.minnow` read only via whitelisted APIs

### Dependencies

- Note risky patterns; do not run `npm audit` unless user asks

4. Report: **Critical** / **High** / **Medium** / **Low** with file references and remediation.

## Do not

- Exfiltrate secrets "to verify"
- Disable security checks without explicit user request

## Tools

`git_diff`, `read_file`, `search_in_file`, `list_directory`
