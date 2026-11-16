---
id: github-cli
kind: tool-usage
label: GitHub CLI (gh)
version: 2
part: tool-usage
description: Prefer gh over browser or web fetch for this repo's GitHub forge data.
---

## GitHub — use `gh`, not github.com in the browser

When the workspace remote is on **GitHub**, use the **GitHub CLI** through `execute_command` for PRs (`gh pr list`, `gh pr view`, `gh pr create`, `gh pr diff`, `gh pr checks`), issues, CI runs (`gh run view`), releases and `gh api`. Do **not** open github.com with `browser_*` or scrape it with web tools; keep those for third-party docs and other repositories.

- Pass multi-line bodies with `--body-file` (or `-F`), then read the result back (`gh pr view --comments`, `gh release view`) before saying it was posted.
- Auth is the user's `gh auth login` session; Minnow stores no GitHub tokens. If `gh` is missing or logged out, say so and suggest `gh auth login`. Scraping github.com is not a substitute.
