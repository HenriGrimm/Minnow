# Workspaces with several repositories

Some projects live in more than one git repository — a `frontend/` and a `backend/`, say, each with its own GitHub remote. You can open the folder that holds them as one Minnow workspace. The editor, file tree, terminal and chat see the whole folder, so one agent can change both sides of a feature, while git work stays per repository.

Minnow finds repositories directly in the workspace folder and one level below it (`apps/web` counts). Folders such as `node_modules`, `dist` and hidden folders are skipped. A workspace with a single repository behaves exactly as it always has.

## Source Control

When the workspace holds two or more repositories, the Source Control header shows a **repository switcher** next to the project name. Pick a repository and every section — Changes, History, Branches, Stashes, Worktrees, Pull requests, Actions, Releases — follows it, and so does the git panel in Code. The command palette (**Ctrl+K** / **Cmd+K**) lists a *Switch to repository* command for each one.

Minnow remembers the last repository you picked for each workspace. The first time, it picks the repository of the file open in the editor.

Commits, pushes and pull requests always belong to one repository. To land a change that spans two, commit and open a pull request in each.

## Agents

The agent's instructions list the workspace's repositories and their remotes. Git tools take an optional `repo` argument, and work it out from file paths when they can: `git_diff` on `backend/src/api.ts` runs in `backend`. Staging files from two repositories in one call is refused, so each commit stays in one repository. For GitHub work the agent runs `gh` from inside the right repository folder.

## Issues

Issues stay in one list for the workspace, so a single issue can describe work across repositories. In the issue detail, the **Repositories** row records which repositories the issue targets. Agents can set it too, and `issue_search` can filter by repository — issues with no repository set match every filter.

Links say which repository they point at: a pull request shows as `backend#12`, so `#12` in one repository is never confused with `#12` in another.

With GitHub sync on, each issue syncs with its own repository:

- A linked issue keeps syncing with the repository it was linked to.
- A new issue is published to the one repository it targets. An issue that targets no repository, or several, is held back with **Choose a repo for this issue before publishing it to GitHub.** Set its Repositories row and sync again.
- Importing reads the issues of every repository that has a remote, and tags each imported issue with its repository.

## Isolated chats

An isolated chat worktree in a folder of repositories is a copy of the folder with one git worktree per repository, each on the chat's branch. Relative paths between the repositories work inside the copy as they do in your folder. When you approve the chat's work, each repository the agent committed to is merged into its own branch; repositories it did not touch are left alone. A merge conflict in one repository keeps the worktree and names the repository; the others stay merged.

## Limits

- **Boards** run in a single repository. Starting a board in a folder of repositories stops with a message asking you to open one of them as the workspace.
- Minnow will not run **Initialize git** on a folder that already holds repositories, because the parent repository would swallow them.
- Git **submodules** are not treated as separate repositories, and repositories outside the workspace folder cannot be added to it.
