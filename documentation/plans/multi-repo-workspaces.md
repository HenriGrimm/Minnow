---
name: multi-repo-workspaces
overview: Let one Minnow workspace folder hold several git repositories (for example `frontend/` and `backend/`, each with its own GitHub remote) with full Source Control, Issues, agent-tool and worktree support. A workspace keeps one root for path safety; its repos become a discovered list, and every git, forge and worktree caller resolves an explicit repo instead of assuming the workspace root is the repo. A single-repo project is the degenerate case (one repo at `.`), so today's behaviour is unchanged.
todos:
  - id: W1-A
    content: "Wave 1: Repo discovery service and API"
    status: pending
  - id: W1-B
    content: "Wave 1: Issue schema gains repo identity"
    status: pending
  - id: W2-A
    content: "Wave 2: Repo resolution for git and forge routes"
    status: pending
  - id: W2-B
    content: "Wave 2: Agent git tools take a repo"
    status: pending
  - id: W2-C
    content: "Wave 2: Repo map in the agent system prompt"
    status: pending
  - id: W3-A
    content: "Wave 3: Source Control repo switcher"
    status: pending
  - id: W3-B
    content: "Wave 3: Per-repo GitHub issue sync"
    status: pending
  - id: W3-C
    content: "Wave 3: Issue repo targeting in tools and UI"
    status: pending
  - id: W4-A
    content: "Wave 4: Multi-repo chat worktrees"
    status: pending
  - id: W4-B
    content: "Wave 4: Multi-repo board slots and integration"
    status: pending
  - id: W5-A
    content: "Wave 5: Docs and context update"
    status: pending
isProject: true
---

# Multi-Repo Workspaces

**Date:** 2026-11-13
**Goal:** A workspace folder containing several independent git repos works in Source Control, Issues, agent tools and isolated worktrees as well as a single-repo workspace does today.
**Granularity:** medium

## Context

Users split products across repos — a front end and a back end with separate GitHub remotes — and want to open the parent folder as one Minnow workspace so one agent can change both sides of a feature. Today Minnow assumes the workspace root *is* the repo:

- Git ops in `server/git/git-ops.js` and forge ops in `server/git/forge-ops.js` accept `cwd` but fall back to `getEffectiveWorkspaceRoot()` via `resolveCwd`. A parent folder that is not itself a repo shows the "no repo" state, and `gh` has no remote to talk to.
- Agent git tools (`toolGitStatus`, `toolGitDiff`, `toolGitLog`, `toolGitAdd`, `toolGitCommit` … in `server/runtime/tools-middleware.js`) always run in the workspace root.
- Issues are scoped by `workspacePath` with one `projectKey` per workspace (`server/mcp-hub/issues.js`). `IssueGitLink` (`src/types.ts`) records a `pr`/`commit`/`branch` ref with no repo, and the issue agent block stores a bare `prNumber`. `IssueGithubLink.repo` exists but is informational; GitHub sync (`src/state/issues-github.ts`) always calls `forge(..., { cwd: issue.workspacePath })`.
- Worktrees (`server/worktree/worktree-ops.js`, `server/worktree/paths.js`) run git in `getEffectiveWorkspaceRoot()` and key the worktree directory by `repoKeyForWorkspace`, so boards and chat worktrees fail outright in a multi-repo folder.

Decisions settled before planning:

1. **Scope is sibling repos under one parent folder** (depth ≤ 2). Folders from different locations (a VS Code style multi-root file) are out of scope: they break the single-root path-safety model.
2. **Nested repos are independent.** If the parent is itself a repo, its children are separate repos too; git submodules are out of scope for v1.
3. **Issues stay workspace-scoped** with one ISS-n numbering. Cross-repo issues are the point ("add the endpoint and the UI"). An issue may target repos; links carry the repo they live in.
4. **Single-repo is the degenerate case.** Every new `repo` argument is optional and defaults to the only repo, so existing callers, tests and stored records keep working.

## Architecture / Key Files

| File | Role | Action |
|------|------|--------|
| `server/workspace/repos.js` | Discover git roots under the workspace, read remotes, cache | CREATE |
| `server/workspace/middleware.js` | Add `GET /api/workspace/repos` | MODIFY |
| `src/state/workspace-repos.ts` | Client cache + `resolveRepoForPath` | CREATE |
| `server/git/repo-resolve.js` | `resolveRepoCwd({ cwd, repo, path })` shared by routes and tools | CREATE |
| `server/git/middleware.js` | Accept `repo` on git/forge requests; `assertAllowedGitCwd` checks it | MODIFY |
| `server/git/forge-ops.js` | `invalidateForgeStatusCache` and `forgeStatus` per repo cwd | MODIFY |
| `server/tools/builtin-catalog.js` | `repo` parameter on `git_*` tool schemas | MODIFY |
| `server/runtime/tools-middleware.js` | Git tool handlers resolve the repo cwd | MODIFY |
| `src/chat/prompts/prompt-composer.ts` | New `workspace-repos` prompt part | MODIFY |
| `src/chat/prompts/tool-usage/github-cli.md` | Tell the agent to `cd` into the repo before `gh` | MODIFY |
| `src/types.ts` | `IssueCard.repos`, `IssueGitLink.repo` | MODIFY |
| `server/config/validators.js` | Normalize the new issue fields, agent `prRepo` | MODIFY |
| `src/ui/source-control-center.ts` | Repo switcher in the rail | MODIFY |
| `src/state/git-api.ts`, `src/state/forge-api.ts` | Pass `repo` on every call | MODIFY |
| `src/state/issues-github.ts` | Sync against the issue's repo, not the workspace | MODIFY |
| `server/mcp-hub/issues.js` | `repos` on `issue_create`/`issue_update` | MODIFY |
| `src/ui/issue-editor.ts` | Repo chips and picker | MODIFY |
| `server/worktree/multi-repo.js` | Compose per-repo worktrees into one mirrored folder | CREATE |
| `server/worktree/worktree-ops.js`, `server/worktree/merge-chat.js`, `server/worktree/paths.js` | Use per-repo cwd and keys | MODIFY |
| `documentation/context.md`, `documentation/manual/` | Describe multi-repo workspaces | MODIFY |

## Wave Breakdown

### Wave 1 — Foundations

#### Task W1-A: Repo discovery service and API
- **Build:** Create `server/workspace/repos.js` exporting `discoverWorkspaceRepos(workspaceRoot = getEffectiveWorkspaceRoot(), { refresh } = {})` returning `WorkspaceRepo[]` where each entry is `{ id, relPath, absPath, remote: { url, host, owner, name } | null, isRoot }`. Detection: the root itself if `git rev-parse --show-toplevel` equals the root, plus every directory up to depth 2 containing a `.git` file or directory; skip `node_modules`, `.minnow`, `.claude`, dot-directories and anything under `getWorktreesRoot()`. `id` is `relPath` with forward slashes (`.` for the root). Parse the `origin` remote with the existing `parseRemoteHost` from `server/git/forge-ops.js`. Cache per normalized root (use `normalizePathForComparison` from `server/workspace/safe-path.js`) with a 30 s TTL plus `invalidateWorkspaceRepos(root)`; call the invalidation where the workspace root changes in `server/workspace/root.js` and after `initialize-git.js` / `clone.js` succeed. Also export `findRepoForPath(absPath, repos)` returning the deepest repo whose `absPath` contains the path. Add `GET /api/workspace/repos` in `server/workspace/middleware.js` returning `{ repos }`. Create `src/state/workspace-repos.ts` with `fetchWorkspaceRepos()`, a module cache keyed by workspace path, and `resolveRepoForPath(path)` mirroring the server helper.
- **Test:** `test/workspace/repos.test.mjs`: build a temp folder with `frontend/` and `backend/` each `git init` with distinct `origin` remotes and assert `discoverWorkspaceRepos` returns exactly two repos with `owner`/`name` parsed; a single-repo temp folder returns one repo with `id: '.'` and `isRoot: true`; a repo under `node_modules/` is ignored; `findRepoForPath` picks `backend` for `backend/src/a.ts` and the nested repo over the root when both match. Run `node --test --test-force-exit test/workspace/repos.test.mjs`.
- **Accept:** With the server running in a two-repo folder, `GET /api/workspace/repos` (with `X-Minnow-Token`) returns both repos and their GitHub `owner/name`.
- **Touches:** `server/workspace/repos.js`, `server/workspace/middleware.js`, `server/workspace/root.js`, `src/state/workspace-repos.ts`, `test/workspace/repos.test.mjs`

#### Task W1-B: Issue schema gains repo identity
- **Build:** In `src/types.ts` add `repos?: string[]` to `IssueCard` (repo ids from W1-A, i.e. workspace-relative paths) and `repo?: string` to `IssueGitLink`. In `server/config/validators.js` add `'repos'` to the normalized issue keys, normalize it to a de-duplicated array of non-empty trimmed strings (drop when empty), normalize `gitLinks[].repo` the same way instead of passing `gitLinks` through untouched, and add `'prRepo'` to `NORMALIZED_AGENT_KEYS`. Do not bump `ISSUES_SCHEMA_VERSION`: absent fields mean "the workspace's only repo", which keeps old and new builds compatible (see `test/issues/schema-forward-compat.test.mts`). Add a pure helper `issueRepoIds(issue, repos)` in `src/issues/repo-scope.ts` returning `issue.repos` if set, else the single repo id when there is exactly one, else `[]`.
- **Test:** `test/issues/repo-fields.test.mts`: `validateIssuesState` keeps `repos: ['backend', 'backend', ' ']` as `['backend']`, keeps `gitLinks[0].repo`, keeps `agent.prRepo`, and round-trips a v3 record without the new fields unchanged; `issueRepoIds` returns `['.']` for a one-repo list and `[]` for an untargeted issue in a two-repo workspace. Run `npx tsx --test --test-force-exit --import ./test/test-loader.mjs test/issues/repo-fields.test.mts` and `npx tsc --noEmit`.
- **Accept:** An issue saved with `repos: ['frontend', 'backend']` survives a server restart with both ids intact.
- **Touches:** `src/types.ts`, `server/config/validators.js`, `src/issues/repo-scope.ts`, `test/issues/repo-fields.test.mts`

### Wave 2 — Repo-aware git, tools and prompt

#### Task W2-A: Repo resolution for git and forge routes
- **Build:** Create `server/git/repo-resolve.js` exporting `resolveRepoCwd({ cwd, repo, path } = {})`: an explicit `cwd` wins (existing behaviour); else `repo` is looked up in `discoverWorkspaceRepos()` and returns its `absPath` or throws `Unknown repo "<id>"; known: …`; else a `path` resolves through `findRepoForPath`; else, if the workspace has exactly one repo, return it; else throw `This workspace has several repos (…); pass repo`. In `server/git/middleware.js`, replace direct use of the request `cwd` with `resolveRepoCwd(body)` for every git and forge action before calling the op, and keep `assertAllowedGitCwd` validating the resolved path under the workspace root. Make `invalidateForgeStatusCache` in `server/git/forge-ops.js` invalidate per resolved repo cwd. Responses include `repo` (the id) so clients can label results.
- **Test:** `test/server/git-repo-resolve.test.mjs`: in a two-repo temp workspace, `resolveRepoCwd({ repo: 'backend' })` returns the backend path, `resolveRepoCwd({ path: 'frontend/src/x.ts' })` returns frontend, `resolveRepoCwd({})` throws the "several repos" error, a single-repo workspace resolves `{}` to the root, and an unknown id throws listing the known ids. Extend `test/server/git-api.test.mjs` so a `status` request with `repo: 'backend'` reports the backend branch. Run both with `node --test --test-force-exit`.
- **Accept:** `POST` to the git status route with `{ repo: 'backend' }` returns the backend repo's branch and changes while the frontend has different ones.
- **Touches:** `server/git/repo-resolve.js`, `server/git/middleware.js`, `server/git/forge-ops.js`, `test/server/git-repo-resolve.test.mjs`, `test/server/git-api.test.mjs`
- **Depends on:** W1-A

#### Task W2-B: Agent git tools take a repo
- **Build:** In `server/tools/builtin-catalog.js` add an optional `repo` string property to the `git_status`, `git_diff`, `git_log`, `git_add`, `git_commit`, `git_checkout` and `git_branch` schemas, described as "Repo id from the workspace repo map; required only when the workspace has several repos and no path identifies one". In `server/runtime/tools-middleware.js`, route every git handler (`toolGitStatus`, `toolGitDiff`, `toolGitLog`, `toolGitAdd`, `toolGitCommit`, checkout/branch handlers, and the shared `runGit`) through `resolveRepoCwd({ repo: args.repo, path: args.path ?? args.paths?.[0] })`. Rewrite path arguments relative to the resolved repo (a `backend/src/a.ts` path becomes `src/a.ts` inside backend). `git_add` with paths in two repos returns an error naming each repo and asking for one call per repo. Errors from `resolveRepoCwd` are returned as tool results, not thrown. Do not rename tools or change `CORE_TOOL_NAMES` in `server/runner/lazy-tools.js`.
- **Test:** `test/server/git-tools-multi-repo.test.mjs`: in a two-repo temp workspace, `git_status` with `repo: 'frontend'` shows only frontend changes; `git_diff` with `path: 'backend/a.txt'` and no repo diffs backend; `git_add` with paths in both repos returns the per-repo error and stages nothing; in a single-repo workspace every tool works with no `repo`. Run `node --test --test-force-exit test/server/git-tools-multi-repo.test.mjs`.
- **Accept:** An agent chat in a two-repo workspace can commit a change in `backend/` with `git_commit({ repo: 'backend', … })` and the frontend repo stays untouched.
- **Touches:** `server/tools/builtin-catalog.js`, `server/runtime/tools-middleware.js`, `test/server/git-tools-multi-repo.test.mjs`
- **Depends on:** W2-A

#### Task W2-C: Repo map in the agent system prompt
- **Build:** Add a `workspace-repos` part to `PART_ORDER` in `src/chat/prompts/prompt-composer.ts`, enabled by a new `isWorkspaceReposPartEnabled(ctx)` only when the compose context carries two or more repos (add `workspaceRepos?: Array<{ id; remote?; branch? }>` to `ComposeContext` and fill it wherever the context is built, from `fetchWorkspaceRepos()` plus each repo's current branch). Render a short list: `- backend — github.com/acme/api (main)`. Place it near the existing workspace guidance and keep it out of the prompt-cache prefix ordering rules already used for volatile parts. In `src/chat/prompts/tool-usage/github-cli.md`, add one line (and update `test/prompts/github-cli-prompt.test.mjs` if it snapshots the text): in a multi-repo workspace run `gh` from inside the repo directory (`cd backend && gh pr create …`).
- **Test:** `test/prompts/workspace-repos-part.test.mts`: `composeSystemPrompt` with two repos includes both ids and remotes; with one repo or none the part is absent and the output is byte-identical to the current snapshot. Run `npx tsx --test --test-force-exit --import ./test/test-loader.mjs test/prompts/workspace-repos-part.test.mts`.
- **Accept:** In a two-repo workspace the composed system prompt lists both repos with their remotes and branches.
- **Touches:** `src/chat/prompts/prompt-composer.ts`, `src/chat/prompts/tool-usage/github-cli.md`, `test/prompts/github-cli-prompt.test.mjs`, `test/prompts/workspace-repos-part.test.mts`
- **Depends on:** W1-A

### Wave 3 — Source Control and Issues

#### Task W3-A: Source Control repo switcher
- **Build:** In `src/state/git-api.ts` and `src/state/forge-api.ts` add an optional `repo` field to every request input and pass it through to the server. In `src/ui/source-control-center.ts` add a repo switcher at the top of the rail, shown only when `fetchWorkspaceRepos()` returns two or more repos; each row shows the repo id, branch and a change count. The selected repo drives every section (Changes, History/graph, Branches, PRs, CI) and the Ctrl+K palette. Persist the selection per workspace with `src/lib/workspace-scoped-map.ts` (never index a byPath map by the client key). Default the selection to the repo of the active editor file via `resolveRepoForPath`, falling back to the first repo. In `src/ui/git-panel.ts`, group the Changes list by repo with a header per repo when there are several. Style in `src/styles/source-control-center.css` with `--mn-*` tokens only and `@container` queries (app surfaces run inside MinnowOS windows).
- **Test:** `test/ui/source-control-repo-switcher.test.mts` (happy-dom; register a tsx-mocks runner rule in `test/test-config.mjs` if it uses `mock.module`): with two mocked repos the switcher renders two rows and selecting `backend` sends `repo: 'backend'` on the next status request; with one repo no switcher renders. Use `test/assert-dom-safe.mjs` helpers for DOM assertions. Run `npx tsx --test --test-force-exit --import ./test/test-loader.mjs test/ui/source-control-repo-switcher.test.mts`.
- **Accept:** In the running app, opening a two-repo folder shows a repo switcher in Source Control, and switching to `backend` shows backend's branch, history and PRs.
- **Touches:** `src/ui/source-control-center.ts`, `src/ui/git-panel.ts`, `src/state/git-api.ts`, `src/state/forge-api.ts`, `src/styles/source-control-center.css`, `test/ui/source-control-repo-switcher.test.mts`, `test/test-config.mjs`
- **Depends on:** W2-A

#### Task W3-B: Per-repo GitHub issue sync
- **Build:** In `src/state/issues-github.ts`, replace every `forge(..., { cwd: issue.workspacePath })` and `readGithubIssueBatch(cwd, …)` with a call that passes `repo`: for a linked issue use the repo whose `remote.owner/name` matches `issue.github.repo` (fall back to `issueRepoIds(issue)[0]`); for a push of an unlinked issue use `issueRepoIds(issue)` and, when it is empty or has several ids in a multi-repo workspace, skip the push and surface "Choose a repo to publish this issue" through the existing sync status. Batch reads group issues by repo so each `issueBatch` call goes to one remote. Import from GitHub sets `repos: [repoId]` and `github.repo: 'owner/name'`. In `src/issues/github-sync-plan.ts`, make `gitLinkDuplicatesGithubIssue` and `nextGithubLink` compare the repo as well as the number, so `#12` in frontend never matches `#12` in backend. Set `IssueGitLink.repo` on every link these paths create.
- **Test:** Extend `test/issues/github-sync-plan.test.mts` with a case where links `#12` in two repos are not duplicates. Add `test/issues/github-sync-multi-repo.test.mts`: two issues linked to different repos produce two `issueBatch` calls with different `repo` values; an unlinked untargeted issue in a two-repo workspace is not pushed and reports the choose-a-repo status; a single-repo workspace behaves exactly as before. Run both with `npx tsx --test --test-force-exit --import ./test/test-loader.mjs`.
- **Accept:** With mirror mode on in a two-repo workspace, an issue targeted at `backend` is created on the backend's GitHub repo, not the frontend's.
- **Touches:** `src/state/issues-github.ts`, `src/issues/github-sync-plan.ts`, `test/issues/github-sync-plan.test.mts`, `test/issues/github-sync-multi-repo.test.mts`
- **Depends on:** W1-B, W2-A

#### Task W3-C: Issue repo targeting in tools and UI
- **Build:** In `server/mcp-hub/issues.js` add an optional `repos` array field to the `issue_create` and `issue_update` field set, validated against `discoverWorkspaceRepos()` ids (unknown ids return an error listing valid ones); `issue_list`/search accept an optional `repo` filter. Wherever the issue agent pipeline records a PR (`src/chat/issues/git-actions.ts`, `src/chat/issues/pipeline.ts`), also record `agent.prRepo` and set `repo` on the `pr` git link. In `src/ui/issue-editor.ts` show the issue's repos as chips with a picker (only in multi-repo workspaces), and show each PR/commit link with its repo prefix (`backend#12`) in `src/issues/clipboard.ts`'s `gitLinkLine`. Add a repo filter to saved views only if it fits the existing filter model in `src/issues/` without a schema change; otherwise leave it out.
- **Test:** `test/issues/issue-tools-repos.test.mts`: `issue_create` with `repos: ['backend']` stores it; with `repos: ['nope']` it errors listing `frontend, backend`; `issue_list` with `repo: 'frontend'` returns only frontend-targeted and untargeted issues; `gitLinkLine` renders `backend#12`. Run with `npx tsx --test --test-force-exit --import ./test/test-loader.mjs`.
- **Accept:** An agent can file one issue targeting both repos, and its detail page shows a chip for each and PR links labelled by repo.
- **Touches:** `server/mcp-hub/issues.js`, `src/chat/issues/git-actions.ts`, `src/chat/issues/pipeline.ts`, `src/ui/issue-editor.ts`, `src/issues/clipboard.ts`, `test/issues/issue-tools-repos.test.mts`
- **Depends on:** W1-A, W1-B

### Wave 4 — Worktrees

#### Task W4-A: Multi-repo chat worktrees
- **Build:** Create `server/worktree/multi-repo.js` exporting `createMirroredWorktree({ key, repos, branch, baseRefs })`: for each selected repo run `worktreeAdd` (from `server/git/git-ops.js`) with that repo as `cwd`, placing it at `<getChatWorktreePath(key)>/<repo.relPath>` so the combined folder mirrors the workspace layout and cross-repo relative paths still resolve; a root repo (`id: '.'`) occupies the folder itself and the child worktrees sit inside it, excluded via the root worktree's `.git/info/exclude`. Return `{ path, repos: [{ id, worktreePath, branch }] }` and write a small `minnow-worktree.json` manifest in the folder. Add `removeMirroredWorktree` and `listMirroredWorktreeRepos`. In `server/worktree/paths.js`, key worktree dirs by workspace root (unchanged) and add `repoKeyForRepo(absPath)` for per-repo bookkeeping. Make the automatic chat worktree path (`server/worktree/merge-chat.js` and its caller in `server/worktree/middleware.js`) use `createMirroredWorktree` with every repo when the workspace has several, and merge back per repo, reporting a per-repo result; a conflict in one repo does not roll back the others but is reported. Dependency install (`ensureDependencyDirs`, `dep-install.js`) runs per repo worktree. Single-repo workspaces keep the current code path.
- **Test:** `test/server/multi-repo-worktree.test.mjs`: in a two-repo temp workspace, `createMirroredWorktree` creates `<path>/frontend` and `<path>/backend` as worktrees on the new branch of their own repos; editing a file in each and merging back lands one commit per repo; a conflict in backend reports `{ repo: 'backend', conflict: true }` while frontend merges; `removeMirroredWorktree` prunes both. Extend `test/server/automatic-chat-worktree.test.mjs` to assert the single-repo path is unchanged. Run with `node --test --test-force-exit`.
- **Accept:** A chat started in an isolated worktree in a two-repo workspace edits both repos and "merge to main" lands one commit in each.
- **Touches:** `server/worktree/multi-repo.js`, `server/worktree/paths.js`, `server/worktree/merge-chat.js`, `server/worktree/middleware.js`, `server/worktree/dep-install.js`, `test/server/multi-repo-worktree.test.mjs`, `test/server/automatic-chat-worktree.test.mjs`
- **Depends on:** W2-A

#### Task W4-B: Multi-repo board slots and integration
- **Build:** In `server/worktree/worktree-ops.js`, thread a `repo` (resolved cwd) through `ensureIntegration`, `createWorktree`, `mergeIntoIntegration`, `mergeInProgress`, `readIntegrationRef` and `rebaseOntoIntegration` instead of the module-level `git()` default of `getEffectiveWorkspaceRoot()`; keep the integration lock (`peakBoardIntegrationLockDepth`) per board **and** repo. A board slot in a multi-repo workspace becomes a mirrored worktree from W4-A covering the repos its task touches: map the task's `Touches` globs to repo ids by their first path segment (a glob with no repo prefix in a multi-repo workspace means every repo). Each repo gets its own integration branch; landing the board opens one PR per repo with changes. Record per-repo results in the board journal under the existing slot record, adding fields only (no V1 resurrection; see `documentation/plans/orchestrator-v2.md`).
- **Test:** Extend `test/orchestrator/worktree-lifecycle.test.mjs` with a two-repo fixture: a task touching `backend/**` gets a slot with only a backend worktree; a task touching both gets both; integration merges keep separate integration branches per repo; the single-repo lifecycle assertions are unchanged. Run `npm run test:orchestrator`.
- **Accept:** A board run in a two-repo workspace finishes with an integration branch in each touched repo and no git command run in the non-repo parent folder.
- **Touches:** `server/worktree/worktree-ops.js`, `server/orchestrator/**`, `test/orchestrator/worktree-lifecycle.test.mjs`
- **Depends on:** W4-A

### Wave 5 — Documentation

#### Task W5-A: Docs and context update
- **Build:** Add a "Multi-repo workspaces" subsection to `documentation/context.md` covering `server/workspace/repos.js`, `resolveRepoCwd`, the issue `repos`/`gitLinks[].repo`/`agent.prRepo` fields, the `workspace-repos` prompt part and mirrored worktrees. Add a user page under `documentation/manual/` describing opening a folder of repos, the Source Control switcher, targeting issues at repos and isolated worktrees, in present tense only (no roadmap talk). Note submodules and repos outside the folder as unsupported in the manual's limits section. Run `npm run test:product-wiki` and fix any index or link failures.
- **Test:** `npm run test:product-wiki` passes; `grep` of `documentation/manual/` for the new page shows it is linked from the manual index.
- **Accept:** The manual has a multi-repo page reachable from its index and `context.md` documents the new fields and modules.
- **Touches:** `documentation/context.md`, `documentation/manual/**`
- **Depends on:** W2-B, W2-C, W3-A, W3-B, W3-C, W4-B

## Verification Checklist
- [ ] `npm test` passes (allowing the known pre-existing failures on `main`)
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` and `npm run check:performance-budgets` pass
- [ ] `npm run test:issues` and `npm run test:orchestrator` pass
- [ ] A single-repo workspace shows no repo switcher, no repo-map prompt part and no behaviour change
- [ ] In a two-repo folder: Source Control switches repos, an issue publishes to the right GitHub repo, an agent commits per repo, and an isolated chat merges one commit into each repo

## Notes for Build Agents
- Every new `repo` argument is optional and defaults to the workspace's single repo. Never make an existing caller pass it; the single-repo path must stay byte-for-byte the same in prompts and identical in behaviour elsewhere.
- Repo ids are workspace-relative paths with forward slashes (`.`, `frontend`, `apps/web`). Never store absolute paths in issues or the board journal.
- Path safety is unchanged: one workspace root, every repo must resolve under it (`validateAllowedWorkspaceRoot`). Do not add a second root.
- `byPath` config maps are re-keyed by the server; read them through `src/lib/workspace-scoped-map.ts`.
- Keep `CORE_TOOL_NAMES` in `server/runner/lazy-tools.js` stable; add parameters, never tools.
- CSS uses `--mn-*` tokens and `@container` queries; no hex literals outside `src/styles/tokens.css`.
- New `mock.module` tests need a tsx-mocks rule in `test/test-config.mjs`; UI test runs need `--test-force-exit`; never `assert.equal` a happy-dom node.
- `npm test` rewrites `test/fixtures/`; reset with `git checkout -- test/fixtures/` before committing.
- Board agents write to the main checkout as well as their worktree; W4-B must not run git in the parent folder of a multi-repo workspace.
