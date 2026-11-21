# Edit, run, and review in Code

Start in an open workspace and choose a thread or **New thread**. The thread header opens the side and bottom panels. Use **+** in an open panel to add another surface. See [Workspace navigation](overview.md) for the launcher and thread card.

Drop a file, editor selection, editor or preview tab, or an existing thread onto **New thread** to open a fresh composer with that item already added. Nothing is sent until you send the message.

### Ask the agent to open another thread

In a supported server-run thread, ask Minnow to open a separate thread. For example: “Open a new thread called Release review, ask it to review the changelog, and tell me what it finds.” Under **Manual** and **Auto**, review the model, checkout and exact first message in the one-time confirmation. In **Full access**, Minnow opens the thread without asking.

The new top-level thread appears in the sidebar without switching your view. It uses the originating thread's verified checkout unless you choose another authorized checkout in the same project. It does not copy the originating transcript or attachments. If you did not ask for a first message, it stays empty. You can open it and continue it yourself. The agent can report the authorized first reply; later actions in another ordinary thread require their own confirmation.

## Find and edit a file

1. Open **Side panel → Files**. Expand a folder and select a file to open an editor tab.
2. Edit the file and save with **Ctrl+S** / **Cmd+S**. Use the file's tab to return to it while keeping the conversation visible.
3. To ask about a specific file, drag its tab into the composer or attach the file from the composer. Include the function, error, or expected behavior in the prompt. For a small replacement in the editor, select the text and use **Ctrl+K** / **Cmd+K** for Quick Edit.
4. To view two files, open both and use the panel's split control or **Ctrl+\** / **Cmd+\**. Use a tab's context menu to move it between groups.
5. To run a script, right-click it in **Files** and choose **Run**. Minnow opens a new terminal tab and runs the file with its usual runner: `bash`, `zsh`, `python`, `node`, `npx tsx`, `ruby`, `perl` or PowerShell. Windows batch files run directly. **Run** appears only for these script types and is unavailable when the terminal is not available.

If completions, formatting, or **Go to definition** are missing, open **Settings**, search for **Language servers**, and check the language for that file. Mixed projects may need a server for each language.

## Local environments in worktrees

Minnow automatically copies Git-ignored local development and test dotenv files into new worktrees before preparing dependencies. This includes `.env`, `.env.local`, `.env.development`, `.env.dev`, `.env.test`, `.env.testing`, their `.local` variants, and files in nested packages. No confirmation or configuration is needed. Existing worktree files are preserved when setup is retried; later edits in one checkout do not update another.

Production, staging, signing, template files, dependency folders and build outputs are not copied. Linked source files are not followed. A destination must also ignore a copied file; if that or another safety check fails, setup reports an error and keeps the checkout for repair and retry. Environment file contents are not shown in setup messages.

Environment copies can still point to shared databases or services. Use the project's isolated test resources before running migrations, seeding data or destructive integration tests. Minnow does not create separate databases or rewrite connection strings.

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

Open **Diff → History** to follow commits through forks and merges. Use **History branch** to browse all refs, the current checkout, or a local or fetched remote branch without switching checkouts. Select a commit to open its diff. **Load older commits** extends the graph.

## Source Control Center

Open **Source Control** from the workspace sidebar. The header shows the workspace, the selected repository in a multi-repo workspace, the checkout, and its current branch. **Changes** shows staged and unstaged files in that checkout. Open a diff, stage the intended files, enter a message, and select **Commit**. With an empty staged list, **Commit all files** stages and commits the changes in the selected repository. Check the branch before pushing.

Use **History** to find the commit that introduced a change. Use **Branches** or **Worktrees** to inspect or switch checkouts. A worktree has its own files and branch, so look for uncommitted changes there before removing it.

### Switch branches and pull requests

Every switch control (the thread's **Checkout** row, the composer's worktree menu, the side panel, **Branches**, **Pull requests** and the history menu) works the same way:

- With uncommitted files, Minnow asks whether to **Bring my changes** or **Leave changes** on the current branch. Changes that stay behind are saved and offered for restore when you return to that branch.
- Git keeps a branch in one worktree at a time. When the branch or pull request is already checked out in another worktree, Minnow offers **Open worktree** (side panel and Source Control) or **Use that checkout** (a thread) instead of failing. Fork pull requests are matched by their tracking branch or head commit.
- Threads on **Local** share the workspace folder and its branches. Switching from a thread asks first if other unarchived threads listed in the sidebar use that checkout, even if they're idle. Where available, **Switch in a new worktree** keeps the change to the current thread. **Switch workspace anyway** changes the branch for everyone using the selected checkout.
- When a switch fails, the message names the cause, such as local changes that would be overwritten, a branch that is not fetched yet, or a running local action, and offers the matching action. The original Git output stays under **Technical details**.
- When a local action is using the checkout, the picker shows **Waiting for** the action's name, with **Stop and switch** and **Try again**.
- The branch list starts with **Recent**: branches you last switched to or from in that checkout. Use the arrow keys to move, **Enter** to switch and the left and right arrows to change tabs.

**Pull requests** marks each open pull request that is **Checked out here** or **In** another worktree, and labels pull requests from forks. **Worktrees** shows each worktree's uncommitted file count, commits to push and pull, and the threads that use it, with **Open chat**.

The thread's **Checkout** row and composer show the current checkout. In Source Control, **Browse checkout** changes which files and branch Source Control displays. **Show chat’s checkout** returns to the current thread’s checkout when it differs. **New Thread** starts on **Local** in the open workspace. In **Worktrees**, select **New thread here** to start a thread in a specific checkout.

Removing a worktree returns the threads that used it to **Local**. **Force remove** is offered only when the worktree has uncommitted or untracked files, and it deletes them.

For pull requests and GitHub Actions, connect GitHub in **Settings → Code and workspace → External Connections**, and make sure the checkout has a GitHub remote. The Source Control app shows repository-level PRs and runs. The thread's **Pull request** surface opens a PR linked to that conversation.

## Code map

Search **Open Code map** in the command palette. Use the map to inspect indexed files and connections. If a recent file is missing, check the active workspace and refresh the code index in [Brain](brain.md).
