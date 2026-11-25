---
name: git-setup
label: Git & GitHub Setup
description: >-
  Initialize git in the workspace and connect a GitHub remote. Use for /git-setup
  before a /factory run or when the user asks to set up version control.
disable-model-invocation: true
---

# Git & GitHub setup

## When to use

- User invokes `/git-setup` or asks to initialize git / connect GitHub
- Orchestrator board preflight requested git setup for a non-repo workspace (init only — no remote)
- Orchestrator board preflight requested GitHub remote setup for a repo without `origin`

## Steps

1. **Detect state** — run `execute_command` with `git rev-parse --is-inside-work-tree` (or `git_status`). If already inside a git repo, skip `git init` and report the current branch and remotes.
2. **Initialize** — when not a repo, run `git init` in the workspace root.
3. **Baseline ignore** — if `.gitignore` does not exist, create one with sensible defaults (`node_modules/`, `.env`, `.env.*`, `dist/`, `build/`, OS junk like `.DS_Store` and `Thumbs.db`). Do **not** overwrite an existing `.gitignore`. Minnow also runs this step programmatically when `/git-setup` starts (before tools run) so fresh repos always get a baseline ignore even if this step is skipped in chat. Orchestrator board onboarding runs init, `.gitignore`, and the initial commit **programmatically** after the dedicated git prompt — do not redo that work if the folder is already a repo.
4. **Initial commit** — when there are untracked files and no commits yet, stage all with `git_add` and commit with message `chore: initial commit`.
5. **GitHub remote**
   - Run `gh auth status`. If unauthenticated, explain that the user must run `gh auth login` in a terminal and stop — do not invent tokens or credentials.
   - When `gh` is available and authenticated: call `ask_question` for repo visibility (**public** / **private**), then run `gh repo create` with `--source=.` and the chosen visibility. Verify `git remote -v` shows `origin`.
   - When `gh` is missing or `gh repo create` fails: call `ask_question` for an existing GitHub remote URL, then `git remote add origin <url>`. Ask before pushing; on approval run `git push -u origin HEAD`.
6. **Summarize** — report branch name, remote URL, and whether the initial push succeeded.

## Do not re-confirm

The user already chose to run this skill (slash command or board preflight). **Do not** call `ask_question` to confirm `git init`, `.gitignore`, the initial commit, or "no GitHub remote". Execute those steps with tools immediately. Use `ask_question` only for GitHub visibility, an existing remote URL, or push approval.

## Quality checks

- Never commit secrets (`.env`, credentials, API keys) — warn and exclude them in `.gitignore` if present
- Do not force-push or rewrite history
- Prefer `gh repo create` over manual remote setup when `gh` works

## Tools

`execute_command`, `git_status`, `git_add`, `git_commit`, `read_file`, `write_file`, `ask_question`
