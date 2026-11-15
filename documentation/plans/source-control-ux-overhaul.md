---
name: source-control-ux-overhaul
planType: build
overview: Make branch, worktree and pull request switching predictable and recoverable, give every surface one consistent idea of "which checkout am I in", and replace raw Git failures with structured, actionable recovery.
---

# Source Control UX overhaul: switching, checkout identity and recovery

## Goal and scope

Switching to a branch or pull request must either succeed, ask exactly one clear question, or route the user to where that branch already lives. It must never dump raw Git output. Every surface (composer, thread header, Git panel, Source Control Center, sidebar) shows the same live answer to "which branch, in which checkout, shared with whom". Scope covers the server checkout layer, the client entry points that switch or remove checkouts, chat↔checkout binding display, and Git error presentation. Commit, history, releases and Actions are touched only where they share these components.

## Review findings (2026-11-15)

### A. PR checkout fails when the PR branch lives in another worktree
1. Picker PR rows call `requestSwitch` directly (`src/ui/git-checkout-picker.ts:312-315`); branch rows redirect to the owning worktree (`:261-265`), PR rows do not.
2. The server runs `gh pr checkout` (`server/git/forge-ops.js:453`), which runs `git checkout <head>` and fails with `fatal: '<branch>' is already used by worktree at '<path>'`.
3. Source Control → Pull requests calls `prCheckout` directly (`src/ui/scc-pulls.ts:582`), bypassing `checkoutSwitch`'s dirty-file consent, expected-branch guard and repository check.
4. Fork PRs: `gh` may create a local branch name different from `headRef`, so name matching alone cannot find an existing checkout; it needs head OID / tracking-ref matching.
5. `src/lib/git-error-parse.ts` has no class for worktree-in-use, so the user sees "Git operation failed" with no recovery.

### B. Five inconsistent switch paths
| Entry point | Path | Dirty consent | Other-worktree check | Running-chat check |
| --- | --- | --- | --- | --- |
| Checkout picker (panel + thread) | `checkoutSwitch` | yes | branches only | thread only |
| SCC header / Branches | `checkoutBranchWithChoice` | yes | disabled button, no route | no |
| Composer run-target "Switch branch" | `gitCheckout` (`composer-run-target.ts:320`) | **no** | filtered list | **no** |
| Graph context menu, merge-to-main | `confirmDirtyCheckout` + `gitCheckout` | "Checkout anyway?"; proceeds if status fails | no | no |
| SCC Pull requests | `prCheckout` | **no** | **no** | no |

Three separate branch-picking UIs exist: the checkout picker, `openGitBranchSwitchPopover` (SCC header) and the composer submenu.

### C. Failure handling
- `assertActionWorktreeIdle` throws "A local action is running…" with no Stop/Wait affordance (`server/git/action-run-lock.js:33`).
- The server returns free-text `error` only; clients pattern-match English output. Checkout-relevant classes are missing: worktree in use, "would be overwritten by checkout", unknown ref/pathspec, `index.lock` exists, checkout busy, stale expected branch.
- A partial PR checkout (branch switched, `gh` update failed) is shown as an error even though the checkout moved (`checkout-switch.js:126-129`).
- Worktree removal offers **Force remove** after *any* failure, describing it as uncommitted changes (`src/ui/scc-refs.ts:1093`). It also never mentions chats bound to that worktree.
- The picker shows errors as a single line of raw text; other surfaces use toasts or the activity popover. Each surface handles errors differently.

### D. "Workspace on one branch, chat on another"
- `chat.gitBranch` is a saved label. It is written on successful switches and backfilled only when empty (`composer-run-target.ts:450-457`); it is never reconciled with the real HEAD. Local chats all share the workspace HEAD but each keeps its own stale label.
- The sidebar derives PR/merge state from `chat.gitBranch` (`src/ui/sidebar-git-state.ts:154`), so a stale label shows the wrong PR.
- The Git panel stops following the chat after any manual worktree pick (`panelCwdUserOverride`, `git-panel.ts:238,297`) and does not say so. The SCC header shows the branch and worktree of that override, not of the active chat (`source-control-center.ts:490-512`).
- Switching the branch from a Local chat silently moves every other Local chat in the workspace. The only guard is "another conversation is *running*" (`thread-checkout.ts:47-51`).
- The composer label distinguishes Local from Worktree, but never says "shared workspace folder" or which branch the folder is actually on.

## Decisions and constraints

- **One server planner, one client controller.** Every switch/PR checkout/worktree route goes through a server pre-flight (`checkoutPlan`) and the existing guarded `checkoutSwitch`. The client uses one `requestCheckout` controller that owns every follow-up question. Plain `checkout`/`prCheckout` ops remain for API compatibility, but no UI calls them.
- **Structured result codes.** Server results add `code` (`in_worktree`, `needs_choice`, `busy`, `overwrite`, `missing_ref`, `stale_branch`, `lock_file`, `forge`, `partial`) plus typed fields. `parseGitError` remains the fallback for uncoded output.
- **Live branch is truth.** UI reads the branch from a per-path checkout-facts store fed by HEAD. `chat.gitBranch` becomes "branch at last activity", used only for history, sidebar fallback and canonical/worktree identity, never as the current-branch label.
- **Shared folder switch (user decision):** when a Local chat switches the workspace folder's branch while other chats are bound to that folder, warn and make **Switch in a new worktree** the default action. **Switch workspace anyway** and **Cancel** remain available.
- **Route, don't refuse.** A branch or PR already checked out elsewhere offers **Open in <worktree>** (Git panel / SCC) or **Use that checkout for this chat** (thread/composer), instead of failing or showing a disabled button.
- **No new storage or settings.** Facts are in memory. Existing stash markers, chat fields and the worktree registry are reused.

Rejected: auto-removing the other worktree to free the branch (destructive). `git checkout --ignore-other-worktrees` (two checkouts of one branch corrupt each other's view). Silently re-pointing the chat (surprising). Blocking all workspace switches (the user chose warn + offer).

## Risks and open questions

- `gh pr view` per PR row is too slow for 200 rows. Detect from the local worktree list first (head name and OID from the existing `prList` fields) and call `gh` only when a row is opened or checked out.
- Live facts for many chats: derive from per-path facts (one entry per checkout), not per chat, so cost scales with worktrees, not chats.
- Canonical (`chatCommandVersion === 1`) chats have server-bound checkouts. The new-worktree default must go through the authenticated workspace route, not renderer-only attach. Confirm during step 5.
- Replacing the SCC header popover changes muscle memory. Keep the existing keyboard shortcut and focus order.
- Open question: should "Recent branches" persist across restarts? This plan keeps it in memory only.

## Relevant files

- `server/git/checkout-switch.js`, `server/git/forge-ops.js`, `server/git/git-ops.js`, `server/git/action-run-lock.js`, `server/git/middleware.js`
- `src/state/git-api.ts`, `src/state/forge-api.ts`, new `src/state/checkout-controller.ts`, new `src/state/checkout-facts.ts`
- `src/lib/git-error-parse.ts`, `src/ui/git-ui-op.ts`, `src/ui/git-activity-overlay.ts`, `src/ui/git-recovery.ts`
- `src/ui/git-checkout-picker.ts`, `src/ui/thread-checkout.ts`, `src/ui/git-checkout-confirm.ts`, `src/ui/composer-run-target.ts`, `src/state/chat-worktree.ts`
- `src/ui/git-panel.ts`, `src/ui/source-control-center.ts`, `src/ui/scc-refs.ts`, `src/ui/scc-pulls.ts`, `src/ui/scc-pr-detail.ts`, `src/ui/git-graph-context-menu.ts`, `src/ui/git-merge-to-main.ts`, `src/ui/git-panel-name-popover.ts`, `src/ui/sidebar-git-state.ts`
- `src/styles/git-checkout-picker.css`, `src/styles/source-control-center.css`
- Tests: `test/server/checkout-switch.test.mjs`, `test/lib/git-error-parse.test.ts`, `test/ui/git-checkout-picker.test.mts`, `test/ui/thread-checkout.test.mts`, `test/ui/scc-pulls.test.mts`, `test/ui/scc-refs.test.mts`, `test/ui/scc-checkout-recovery.test.mts`, `test/ui/git-panel-branch-sync.test.mts`, `test/state/chat-worktree.test.mts`
- Docs: `documentation/context.md`, `documentation/manual/apps/code.md` (Source Control Center)

## Implementation steps

### 1. Server checkout planner and structured results
- [ ] A pre-flight reports where a branch or PR lives and what the switch would cost, without mutating anything.
- Changes: Add `checkoutPlan({ cwd, branch? , pullRequest? })` in `server/git/checkout-switch.js` and register it in `middleware.js`.
- Read `git worktree list --porcelain` once. For branches, match by `branch refs/heads/<name>`. For PRs, resolve `gh pr view <n> --json headRefName,headRefOid,isCrossRepository,headRepositoryOwner`, then match a worktree whose branch is the head name, whose HEAD equals `headRefOid`, or whose branch merges `refs/pull/<n>/head`.
- Return `{ ok, target: { branch, localBranch? }, location: 'current' | 'here' | 'worktree', worktreePath?, dirty: { fileCount }, busy?: { label } }`.
- Make `checkoutSwitch` call the same detection before any stash or `gh` call and return `{ ok:false, code:'in_worktree', worktreePath, branch }` with nothing stashed. Add `code` to existing outcomes: `needs_choice`, `stale_branch`, `busy` (catch `assertActionWorktreeIdle`, include the action label), and `partial` (PR branch moved, update failed; `ok:false` stays for compatibility but the client treats it as a warning).
- Classify Git stderr server-side into `overwrite`, `missing_ref`, `lock_file` and `in_worktree` (race fallback).
- Acceptance: a PR or branch in another worktree returns `in_worktree` with its path and leaves the stash list and branch untouched. A fork PR is detected by head OID. Existing tests still pass.
- Verify: Extend `test/server/checkout-switch.test.mjs` with real-Git linked-worktree fixtures (branch, same-name PR, fork PR via OID, busy lock, overwrite conflict).

### 2. Error vocabulary and one recovery presentation
- [ ] Every checkout failure has a title, a plain summary and at least one action.
- Changes: Add `worktree_in_use`, `overwrite`, `missing_ref`, `lock_file`, `busy` and `stale` kinds to `src/lib/git-error-parse.ts`. Prefer `result.code` when present.
- Add a shared `GitRecoveryAction` list (`Open in worktree`, `Use that checkout for this chat`, `Stop action`, `Bring/Leave changes`, `Refresh branches`, `Fetch and retry`, `Send to chat`) rendered by both the picker's inline notice and the activity error popover. Keep technical output under a "Technical details" disclosure.
- Show `partial` as a warning: "Switched to X, but updating from GitHub failed".
- Tighten generic patterns that misclassify (`\btimeout\b`, bare `fix conflicts`).
- Acceptance: no checkout surface shows raw Git text as its primary message. `test/lib/git-error-parse.test.ts` covers real stderr samples for each kind.
- Verify: `test/lib/git-error-parse.test.ts`, `test/ui/scc-checkout-recovery.test.mts`.

### 3. Client checkout controller and entry-point consolidation
- [ ] All switch entry points share one flow and one set of questions.
- Changes: Create `src/state/checkout-controller.ts` exporting `requestCheckout({ scope: 'panel' | 'chat', chat?, cwd, branch? , pullRequest?, create?, startPoint? })`. The flow is: plan → shared-folder guard (step 5) → dirty choice → `checkoutSwitch` → map `code` to recovery actions → emit `GIT_CHECKOUT_CHANGED_EVENT` and refresh facts.
- Route `git-checkout-picker` (branches **and PR rows**), `thread-checkout`, SCC header/Branches, `scc-pulls` / PR detail Checkout, `composer-run-target` `applyBranchCheckout`, the graph context menu and `git-merge-to-main` through it. Delete `confirmDirtyCheckout` once unused.
- Replace the composer "Switch branch" submenu with the thread checkout picker in inline mode, so the composer and thread header share one UI.
- Replace the SCC header's separate branch popover and worktree button with the shared dropdown checkout picker. Keep `openGitBranchSwitchPopover` only for create-from-ref flows.
- Acceptance: grep finds no UI caller of `gitCheckout`, `prCheckout` or `confirmDirtyCheckout`. A dirty tree always gets the Bring/Leave question, from every entry point.
- Verify: `test/ui/git-checkout-picker.test.mts`, `test/ui/thread-checkout.test.mts`, `test/ui/scc-pulls.test.mts`, `test/ui/scc-refs.test.mts`, plus a new `test/state/checkout-controller.test.mts`.

### 4. Live checkout facts and one checkout identity component
- [ ] Every surface shows the same live branch and location.
- Changes: Add `src/state/checkout-facts.ts`, a per-path cache of `{ branch | detached sha, dirtyCount, ahead/behind, chatsBound[] }`. Feed it from existing status polls, `refreshSidebarGitFacts` and `GIT_CHECKOUT_CHANGED_EVENT`. Never start a new poll loop.
- Add a `createCheckoutBadge()` component showing `branch · Workspace (shared with N)`, `branch · <worktree>`, `Detached at abc123`, `Setting up…` or `Busy: <action>`. Use it in the composer run-target label, the thread header, the Git panel picker trigger and the SCC header.
- Stop displaying `chat.gitBranch` as current. Write it from facts after each turn and switch, as "last seen branch". Sidebar `chatGitState` prefers live facts for the chat's checkout and falls back to `gitBranch` for archived or offline chats.
- Acceptance: switching branches in a terminal updates all labels within one poll. Two Local chats in one folder show the same branch.
- Verify: `test/ui/git-panel-branch-sync.test.mts`, `test/state/chat-worktree.test.mts`, sidebar git-state tests and a new facts unit test.

### 5. Shared-folder guard and chat↔panel follow state
- [ ] Users always know whether an action affects only this chat.
- Changes: In `requestCheckout` with `scope: 'chat'` on a Local chat, count other non-archived chats bound to the same folder. If any exist, ask: "**N other chats use the workspace folder.** Switching changes their files too." The options are **Switch in a new worktree** (default focus), **Switch workspace anyway** and **Cancel**. The new-worktree choice reuses `worktreeAdd` with `checkoutExisting` (or the owning worktree if one exists) and `applyChatRunTargetChoice({ kind:'attach' })`. The running-chat refusal remains.
- Git panel and SCC: when the shown checkout differs from the active chat's checkout, show a slim bar, "Viewing <badge> — this chat uses <badge>", with a **Follow chat** button that clears `panelCwdUserOverride`. SCC header names the chat it follows.
- Acceptance: switching from a Local chat with siblings never moves the folder without the explicit choice. A manual panel worktree pick is always visibly marked.
- Verify: `test/ui/thread-checkout.test.mts`, `test/ui/panel-worktree-cwd.test.mts`, `test/os/source-control-app.test.mts`.

### 6. Worktree and branch list polish
- [ ] Lists show where things live and route there.
- Changes: SCC Branches: replace the disabled Checkout on in-worktree branches with **Open worktree**, and show the worktree name chip.
- PR list and detail: show "Checked out here", "In <worktree>" or "Fork" tags, using `checkoutPlan` results cached per list load. The primary action becomes **Open** when the PR is already checked out.
- Worktrees list: show bound chats, dirty count and ahead/behind; add an **Open chat** action. Removal confirmation lists bound chats and detaches them to Local on success. Offer **Force remove** only when the failure is classified as dirty or untracked.
- Busy checkout: show "Waiting for <action>" with **Stop action**, using the existing local action cancel.
- Picker: add a "Recent" group (last five branches switched to in this checkout, in memory) and a keyboard hint row. Keep `--mn-*` tokens and `@flaticon/flaticon-uicons` icons per the project conventions.
- Acceptance: no disabled button that leaves a dead end. Removing a chat's worktree never leaves the chat pointing at a missing path.
- Verify: `test/ui/scc-refs.test.mts`, `test/ui/scc-pulls.test.mts`, `test/server/worktree-ops.test.mjs`, and an inspection of the rendered UI at desktop and narrow widths.

### 7. Regression, docs and release checks
- [ ] Behavior is covered and documented.
- Changes: Update `documentation/context.md` (checkout planner, result codes, facts store) and `documentation/manual/apps/code.md` (switching, PRs in worktrees, shared-folder prompt, follow-chat bar).
- Run focused suites, `npm run test:check-coverage`, `npx tsc --noEmit` and `npm run impeccable:detect` on the touched UI. Inspect the git diff and status.
- Acceptance: affected suites and the typecheck pass. Unrun or platform-limited checks are reported.
- Verify: The commands above.

## Acceptance checklist

- [ ] Checking out a PR whose branch is in another worktree offers to open that worktree and never errors or stashes.
- [ ] Every switch entry point asks the same dirty-file question and uses the same recovery actions.
- [ ] Composer, thread header, Git panel, SCC and sidebar agree on the live branch for a checkout.
- [ ] Switching the shared workspace folder from a chat with sibling chats defaults to a new worktree.
- [ ] The panel/SCC visibly indicate when they are not following the active chat.
- [ ] Force-removing a worktree is offered only for dirty-tree failures, and bound chats are handled.
- [ ] No raw Git output is the primary message of any checkout failure.
