# Workspaces with several repositories

Some projects live in more than one git repository — a `frontend/` and a `backend/`, say, each with its own GitHub remote. You can open the folder that holds them as one Minnow workspace. The editor, file tree, terminal and chat see the whole folder, so one agent can change both sides of a feature, while git work stays per repository.

Minnow searches the workspace folder and its subfolders for repositories. Folders such as `node_modules`, `dist` and hidden folders are skipped.

## Source Control

When the workspace holds two or more repositories, the Source Control header shows a **repository switcher** next to the project name, followed by the checkout and branch. Pick a repository and every section follows it. The Git panel in Code uses the same repository preference. The command palette (**Ctrl+K** / **Cmd+K**) lists a *Switch to repository* command for each repository.

**Fetch**, **Pull**, and **Push** act on the selected checkout by default. The **Sync options** menu at the right of the group offers **Fetch all**, **Pull all**, and **Push all**. Turn on **Main buttons sync all repos** to use those actions directly from the buttons. Minnow remembers the setting for this workspace. When you’re browsing a linked worktree, bulk sync uses that worktree for its repository and the existing checkouts for the others. Minnow reports any repositories that were skipped or could not sync.

In Code, the Changes panel and the thread's **Checkout** picker also let you choose a repository for changes, branches, and pull requests. You can switch repositories while the editor and chat continue to use the full workspace. Minnow remembers the last repository you picked for each workspace. The first time, it picks the repository of the file open in the editor, when available.

Commits, pushes and pull requests belong to one repository. To land a change that spans two, commit and open a pull request in each. Unsubmitted pull request drafts stay with their repository and branch while you switch between them in the current window. If repository discovery fails, use **Retry repository discovery**.

## Agents

The agent's instructions list the workspace's repositories and their remotes. Git tools take an optional `repo` argument, and work it out from file paths when they can: `git_diff` on `backend/src/api.ts` runs in `backend`. Staging files from two repositories in one call is refused, so each commit stays in one repository. For GitHub work the agent runs `gh` from inside the right repository folder.

## Issues

**Current workspace** shows issues filed in the open folder and its child workspaces. Use **Filter → Sub-workspace** to narrow the list or board to a repository or a folder of repositories. Issues assigned to several repositories appear under each one.

In an issue, use **Repositories** to assign work to one or more repositories. **Git → Create branch** and **Create pull request** use the assigned repository. If the issue targets several, choose one when you run the action. A Git action always runs in one repository, and the branch or pull request link records which one.

With GitHub sync on, each issue syncs with its own repository:

- A linked issue keeps syncing with the repository it was linked to.
- A new issue is published to the one repository it targets. An issue that targets no repository, or several, is held back with **Choose a repo for this issue before publishing it to GitHub.** Set its Repositories row and sync again.
- With **Two-way mirror** enabled, use **Sync all** to bring in open and closed issues from the workspace’s GitHub repositories. New imports are tagged with their repository and appear in **Triage**.

## Isolated chats

An isolated chat worktree in a folder of repositories is a copy of the folder with one git worktree per repository, each on the chat's branch. Relative paths between the repositories work inside the copy as they do in your folder. When you approve the chat's work, each repository the agent committed to is merged into its own branch; repositories it did not touch are left alone. A merge conflict in one repository keeps the worktree and names the repository; the others stay merged.

## Limits

- **Boards** run in a single repository. Starting a board in a folder of repositories stops with a message asking you to open one of them as the workspace.
- Minnow will not run **Initialize git** on a folder that already holds repositories, because the parent repository would swallow them.
- Git **submodules** are not treated as separate repositories, and repositories outside the workspace folder cannot be added to it.
