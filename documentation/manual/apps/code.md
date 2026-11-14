# Edit, run, and review in Code

Start in an open workspace and choose a thread or **New thread**. The thread header opens the side and bottom panels. Use **+** in an open panel to add another surface. See [Graphite navigation](overview.md) for the launcher and thread card.

## Find and edit a file

1. Open **Side panel → Files**. Expand a folder and select a file to open an editor tab.
2. Edit the file and save with **Ctrl+S** / **Cmd+S**. Use the file's tab to return to it while keeping the conversation visible.
3. To ask about a specific file, drag its tab into the composer or attach the file from the composer. Include the function, error, or expected behavior in the prompt. For a small replacement in the editor, select the text and use **Ctrl+K** / **Cmd+K** for Quick Edit.
4. To view two files, open both and use the panel's split control or **Ctrl+\** / **Cmd+\**. Use a tab's context menu to move it between groups.

If completions, formatting, or **Go to definition** are missing, open **Settings**, search for **Language servers**, and check the language for that file. Mixed projects may need a server for each language.

## Terminal

Open **Terminal** from the panel launcher or use **Ctrl+`**. Before running a command that writes files, check the working directory with `pwd` in a Unix shell or `Get-Location` in PowerShell. A thread on a worktree uses a different checkout from the main folder. To change shells, search **Default shell** in Settings. Interrupt a running command with **Ctrl+C**.

## Dev servers

1. Start your project's ordinary dev command in **Terminal**, for example `npm run dev` if it is defined in `package.json`. Leave the process running.
2. Copy the local URL printed by that command. Open **Browser** from the surface launcher and enter it.
3. To manage a project server from Minnow, open **Dev servers** from the command palette. Select the server to view its logs or start and stop it from the server controls. The **Browser** surface can also show the selected dev server and its log.

If the page is blank, open the same URL in the system browser and check the port and terminal output. If the system browser works and the embed does not, see [Preview troubleshooting](../reference/troubleshooting.md#the-preview-is-blank).

## Browser preview

Open **Browser** to keep a page alongside the thread. Use the preview width selector to check responsive layouts and the reload button after a change. The desktop app provides the native browser and agent browser tools. See [Integrations](../extend/integrations.md#browser-automation) for the browser's requirements.

## Review the thread's work

1. Read the **Edited** summary below the reply for the files changed in that turn. Open **Diff** from the side panel launcher and select a file to inspect the patch in the thread's Git checkout.
2. Use **Open workspace diff** beside **Diff** in the launcher to inspect the main workspace, including edits outside a thread's separate worktree.
3. Run the relevant checks in **Terminal**. If a failure needs investigation, give the agent the exact command and the first error.
4. To commit, inspect staged and unstaged changes in **Source Control**.

## Source Control Center

Open **Source control** from the workspace sidebar. In a Git workspace, **Changes** shows the current checkout's staged and unstaged files. Open a diff, stage the intended files, enter a message, and confirm the staged list before selecting **Commit**. With an empty staged list, the commit control can include all working tree changes. Check the branch before pushing.

Use **History** to find the commit that introduced a change. Use **Branches** or **Worktrees** to inspect or switch checkouts. A worktree has its own files and branch, so look for uncommitted changes there before removing it.

For pull requests and GitHub Actions, connect GitHub in **Settings → Code and workspace → External Connections**, and make sure the checkout has a GitHub remote. The Source Control app shows repository-level PRs and runs. The thread's **Pull request** surface opens a PR linked to that conversation.

## Code map

Search **Open Code map** in the command palette. Use the map to inspect indexed files and connections. If a recent file is missing, check the active workspace and refresh the code index in [Brain](brain.md).
