# Run jobs with Automations

Open **Automations** from the command palette. Jobs run while Minnow is running, including in the tray. Scheduled runs missed while fully quit are skipped.

## Test a job before scheduling it

1. Select **New automation**, then **Custom**. Pick the project folder and the model the job should use.
2. Write a prompt with the command, expected output, and instructions for a failure. For example, “Run `npm test` in this workspace. Report the exit code and up to three failing tests. Leave files unchanged. If the script is unavailable, report that and stop.”
3. Choose **Only when I run it**, then select **Run once now** in setup. You can use **Run now** from the hub for later tests. Open the run and inspect the transcript. Use **Stop run** if it is acting on the wrong item or workspace.
4. Edit the job to use **On a schedule**. Enter a schedule such as `weekdays at 9am` or a cron expression, then verify the displayed next run. The schedule uses the host's local timezone.

Jobs use the current permission mode. They cannot answer interactive questions or grant tool approvals. If a run fails on permissions or lacks a required tool, simplify the prompt or change its inputs, then test it again.

## Use a GitHub preset

Connect GitHub and select a checkout whose `origin` matches the repository. In **New automation**, choose the preset and review its generated instructions and options before starting it. A **PR Reviewer** can post a review and, if configured, merge eligible PRs. Check the selected action when you only need comments. **Issue Watcher** picks up issues with its configured label, runs implementation on a board, and can publish a PR after verification.

## Diagnose a job

Open **Needs you** for failures and blocked runs. Check the transcript for the exact missing input, failing command, or authentication error. Use **Retry** when the cause is fixed. A quiet run that found nothing to do appears in history without a notification. Pause a job to stop future polls and use **Stop run** for a currently running job.
