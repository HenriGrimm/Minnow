---
name: create-pr
label: Create PR
description: >-
  Push the current branch and open a GitHub pull request with gh. Use when the
  user asks to create or open a PR from the code-change strip or /create-pr.
disable-model-invocation: true
---

# Create pull request

## When to use

- User clicks **Create PR** on the code-change strip or invokes `/create-pr`
- User asks to open a pull request for the current branch

## Steps

1. Run `git_status` — note branch, staged/unstaged state, and whether `origin` exists.
2. If there are uncommitted changes that belong to this work, ask the user if they would like to commit this first. Do not open a PR on a dirty tree unless the user explicitly asked to include uncommitted work.
3. Run `git_log` (recent commits) and `git_diff` as needed to summarize what the PR contains.
4. Push the current branch: `execute_command` with `git push -u origin HEAD` when upstream is missing, otherwise `git push`.
5. Create the PR: `execute_command` with `gh pr create` and a clear title (≤72 chars) plus a body that explains **why** (user impact, not a file list). Use `--fill` only when it produces a good title/body.
6. Return the PR URL from gh output. If gh is missing, say so plainly.

## Quality checks

- Title matches the committed scope on this branch
- Body follows the shared **Pull request descriptions** guidance: plain-language **What changed**, reproducible **How to test** steps for functional changes, and embedded **Before and after** screenshots for UX changes.
- No secrets in PR title or body
- If push fails (no remote, auth), report the error and do not claim the PR exists

## Tools

`git_status`, `git_log`, `git_diff`, `execute_command`
