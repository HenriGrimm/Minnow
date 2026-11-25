# Workspaces with several repositories

Some projects live in more than one git repository — a `frontend/` and a `backend/`, say, each with its own GitHub remote. You can open the folder that holds them as one Minnow workspace. The editor, file tree, terminal and chat see the whole folder, so one agent can change both sides of a feature, while git work stays per repository.

Minnow searches the workspace folder and its subfolders for repositories. Folders such as `node_modules`, `dist` and hidden folders are skipped. Inside a Git repository, nested checkouts that it ignores or tracks as submodules are not treated as separate workspace repositories, so their GitHub issues are not imported.

## Source Control

When the workspace holds two or more repositories, the Source Control header shows a **repository switcher** next to the project name, followed by the checkout and branch. Pick a repository and every section follows it. The Git panel in Code uses the same repository preference. The command palette (**Ctrl+K** / **Cmd+K**) lists a *Switch to repository* command for each repository.

**Fetch**, **Pull**, and **Push** act on the selected checkout by default. The **Sync options** menu at the right of the group offers **Fetch all**, **Pull all**, and **Push all**. Turn on **Main buttons sync all repos** to use those actions directly from the buttons. Minnow remembers the setting for this workspace. In a chat worktree, bulk sync uses that chat’s isolated checkouts. If you open a standalone worktree for a single repository, bulk sync uses that checkout for its repository and the workspace checkouts for the others. Minnow reports any repositories that were skipped or could not sync.

If a repository needs a pull strategy, **Pull all** names it in the prompt. **Cancel** skips that repository and continues with the others.

In Code, the Changes panel and the thread's **Checkout** picker also let you choose a repository for changes, branches, and pull requests. You can switch repositories while the editor and chat continue to use the full workspace. Minnow remembers the last repository you picked for each workspace. The first time, it picks the repository of the file open in the editor, when available.

Commits, pushes and pull requests belong to one repository. To land a change that spans two, commit and open a pull request in each. Unsubmitted pull request drafts stay with their repository and branch while you switch between them in the current window. If repository discovery fails, use **Retry repository discovery**.

## Agents

The agent's instructions list the workspace's repositories and their remotes. Git tools take an optional `repo` argument, and work it out from file paths when they can: `git_diff` on `backend/src/api.ts` runs in `backend`. Staging files from two repositories in one call is refused, so each commit stays in one repository. For GitHub work the agent runs `gh` from inside the right repository folder.

## Issues

**Current workspace** shows issues filed in the open folder and its child workspaces. Use **Whole workspace** in the Issues header to narrow the list or board to a repository or a folder of repositories. Issues assigned to several repositories appear under each one.

The **Workspace** column appears in multi-repo workspaces and in **All workspaces**. Select its header to sort by the displayed names. Select a workspace or repository name on an issue to filter the list or Pipeline. An issue assigned to several repositories has a separate filter button for each one. Select the active name again to clear the filter. Hover over a name to see its full folder path.

The Issues side panel in Code includes child workspace issues. For multi-repo workspaces, select a repository label or use **Filter → Workspace** to narrow the list. Use **Sort issues** to switch between newest first and workspace order.

In an issue, use **Repositories** to assign work to one or more repositories. **Git → Create branch** and **Create pull request** use the assigned repository. If the issue targets several, choose one when you run the action. A Git action always runs in one repository, and the branch or pull request link records which one.

Use **Import from GitHub** in the Issues header to bring open and closed issues from the workspace’s GitHub repositories into Triage. With **Two-way mirror** enabled, the header shows **Sync all**. It imports those issues and syncs existing cards with GitHub.

Minnow displays one level of sub-issues. When a GitHub issue’s parent is itself a sub-issue, the imported card can appear as a top-level issue. Minnow preserves its GitHub parent when syncing other edits.

With GitHub sync on, an issue syncs with each repository it targets:

- Minnow keeps one local card and creates one GitHub issue in each targeted repository. Existing GitHub links remain linked when you change the targets. Retrying after a partial failure reuses copies already linked.
- An unlinked issue with no target publishes to the Git repository at the workspace folder, if there is one. If the folder has no repository of its own, Minnow uses the only child repository or asks you to choose under **Repositories** when there are several.
- To delete the GitHub copies of a multi-repo card, delete them individually on GitHub. You can delete the local card without deleting its GitHub copies.

## Isolated chats

Choose **Enable worktree** in the chat composer, then send a message. Minnow creates a Git worktree for each repository at the same relative path. Each starts from that repository’s committed state. The chat, Files, editor, and new terminal tabs use the folder containing both checkouts. The repository switcher in Changes and Source Control selects where Git actions run.

Open **Review worktree changes** from the composer, select a repository in **Source Control → Changes**, and commit its edits. Select **Merge worktree** to review and merge those commits into that repository’s starting branch. Repeat for the other repository when it’s ready. Any conflict stays with its repository, and both isolated checkouts stay available. **Back to Local** switches the chat to the original folder and keeps the isolated work.

For a linked issue, use **Work → Repository** to review, commit, or merge one repository at a time. **Create pull request** publishes the linked chat’s branch for the selected repository.

## Limits

- Minnow will not run **Initialize git** on a folder that already holds repositories, because the parent repository would swallow them.
- Git **submodules** are not treated as separate repositories, and repositories outside the workspace folder cannot be added to it.
