# Capture, assign, and review issues

Open **Issues** from the command palette. Select the workspace you want to work in. To keep issues beside a Code thread, open the surface launcher and use **Open issues** beside **Issue**.

## Capture a bug in context

1. Use **New issue** in Issues, or **Capture issue** in a Code thread. The thread capture can link the current conversation.
2. Give it a title that names the observed problem. Add steps, the expected result, the actual result, and a screenshot or log if it helps.
3. Use **Expand** to propose a clearer description and labels. Read the result before applying it. Use **Create** or **Capture** to save.
4. Use **Needs review** to triage incoming issues. Open an issue to edit its status, priority, labels, or project. Choose **Board** if moving cards between statuses is easier for the task.

## Hand it to an agent

1. Open the issue and read the description and linked work. Add test or acceptance criteria before dispatching it.
2. Choose **Start thread** and check the workspace and model. Enable **New worktree** if the repo is in Git and you want the new thread to work in a separate checkout.
3. Use the issue's **Chat** tab or linked conversation list to follow the work. In Code, **Issue** opens the linked card beside the transcript.
4. When the agent finishes, use **Review work** or the issue's **Work** tab. Read the changed files, check the tests, and inspect the checkout in [Source Control](code.md#source-control-center) before publishing or closing the issue.

## Sync with GitHub

Sign in under **Settings → Code and workspace → External Connections** and check that the workspace points at the intended GitHub repository. Find GitHub sync options by searching Settings for **Issues**. Use import to bring open issues into triage or push a local issue from its **Git** section. Review the direction and repository before enabling **Two-way mirror** or **Sync automatically**.

If a row says **Needs push** or **Conflict**, open its Git section and inspect sync status before editing both copies. When deleting a linked issue, choose **Local only** to retain the GitHub issue or **Delete everywhere** to remove both copies.
