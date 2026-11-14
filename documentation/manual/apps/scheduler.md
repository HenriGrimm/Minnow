# Automations

Automations are agents that run on their own: a PR reviewer that checks every new pull request, an issue watcher that fixes labeled issues, a nightly dependency check, or anything you describe. Each one wakes up on its schedule, does its job without a conversation, and reports back in one place.

Open **Automations** from the app rail. It opens as the foreground **main app**.

## The one rule

**Automations only run while Minnow is running.** Hidden in the system tray counts as running — that is the normal case, since closing the window hides to tray by default. Fully quitting stops every automation.

Minnow does not install an OS-level scheduled task, and it does not backfill runs it missed while closed. If an automation must survive reboots, enable **Launch Minnow at startup** under **Settings → General → Desktop app**. At most two automations run at the same time; others wait for a free slot.

## The hub

The hub shows everything at once:

- **Needs you** — automations waiting on a person: a PR review that could not finish, an issue the watcher blocked on, or a run that failed. **Open** jumps to the run; **Retry** queues it again and starts a run.
- **Running now** — one card per agent at work, with what it is working on (for example `#142 Scatter radius scales with predator speed`), its reviewers, the step it is on right now, and how long it has been running. Select a card to watch the run.
- **All automations** — what triggers each one, its last 20 runs as small ticks, when it runs next, and a switch to pause it. A short grey tick is a run that found nothing to do; red is a failure.
- **Activity** — claims, merges, change requests, failures and finished runs, newest first.

The header filter shows all, running, or paused automations.

## Watching a run

Select an automation to open it. The left column lists its work (the PR queue, watched issues) and its runs; runs that had nothing to do are folded away. The middle shows the selected run in the same transcript view as a chat — tool calls, edits, and the agent's replies — updating live while it runs. The right column shows the item it is working on and the automation's settings.

**Stop run** ends a run that is in progress, including any reviewers it started. **Run now** starts one immediately. A finished run that was saved as a chat offers **Continue in Code**, which opens that conversation so you can follow up.

## Presets

**New automation** opens the presets. Each one asks only for what it needs and shows what it is allowed to do.

| Preset | What it does | Default schedule |
|--------|--------------|------------------|
| **PR Reviewer** | Reviews open PRs with parallel reviewers, then merges, approves, or requests changes | Every 2 minutes |
| **Issue Watcher** | Plans and fixes issues labeled `minnow` on a board, then opens a PR | Every 5 minutes |
| **CI Fixer** | When checks fail on the default branch, finds the cause and opens a fix PR | Every 10 minutes |
| **Issue Triage** | Labels new issues, links duplicates, asks for missing repro steps | Every 10 minutes |
| **Release Notes** | Drafts release notes from merged PRs for a new tag; leaves the release as a draft | Every 30 minutes |
| **Standup Digest** | Summarizes the previous day's changes into a dated Brain page | Weekdays 9:00 AM |
| **Dependency Check** | Finds outdated or vulnerable packages and opens one PR with the bumps that pass the tests | Mondays 8:00 AM |
| **Docs Drift** | Checks docs against recently changed code and files an issue per stale page | Daily 6:00 PM |
| **Custom** | Your own instructions | You choose |

GitHub presets need a local checkout whose `origin` points at the repository on GitHub.com, and the GitHub CLI signed in (`gh auth login`). Choosing the checkout fills in the repository and shows whether the origin matches.

Preset instructions are written from the options you pick and shown on the setup screen. **Edit** replaces them with your own words; from then on the options no longer rewrite them. A preset run that finds nothing to do replies `NOTHING_TO_DO` and stays quiet: no notification, a grey tick in the hub.

You can also describe an automation at the top of **New automation** — for example "Every weekday at 9, summarize what merged yesterday into Brain". Minnow fills in a Custom automation with that schedule and those instructions for you to check before creating it.

## PR Reviewer

Each run takes the oldest open PR that nobody has taken and handles it start to finish:

1. **Pick** the oldest open PR. Drafts are skipped. With **Skip PRs that already have a comment** on, a PR someone already commented on is left alone. A PR is reviewed again only after new commits.
2. **Claim** it (on by default): comment "Review in progress", wait 5 seconds, and re-read the thread. If another agent claimed the same commit first, the reviewer deletes its comment and backs off, so parallel agents never review the same PR twice.
3. **Review** with the reviewers you chose — Correctness, Tests, Security, Performance, Style & naming — running in parallel in a separate worktree of the PR. Each reviewer only reads and runs checks, and finishes with a verdict and findings with file and line. Select a reviewer in the run to read its transcript.
4. **Report** one result comment on the PR, with each reviewer's verdict and findings.
5. **Act**: if every reviewer passes, add the PR to the merge queue (with auto-merge), merge it now, approve it, or only comment — your choice. Otherwise request changes, or only comment. Branch protection and required checks still apply.

If a reviewer does not return a verdict, the PR is marked as needing attention, a short comment says the review could not finish, and nothing is merged. Retry it from **Needs you** or the PR list. Records live under `scheduler-runs/pr-review/` in your Minnow home.

## Issue Watcher

The watcher processes open issues with the **minnow** label, including issues already labeled when it starts. It handles one issue at a time per repository:

1. A planning agent researches and triages the issue in a separate worktree. Optional **Additional guidance** supplies repository-specific constraints.
2. An Orchestrator board implements the plan with Builder and Tester agents.
3. When every task has merged into the board's integration branch and its final test passes, Minnow pushes that branch and opens a PR against the repository's default branch. The PR includes the board's implementation and validation report.
4. GitHub issue comments announce planning, implementation, failures needing attention, and the completed fix with its PR link. PRs remain open for your review and merge.

The watcher's issue list shows claimed issues, errors, and PR links; **Retry** requeues a blocked issue for the next poll. If a board failed, review and rerun its failed work in Code's Boards surface before retrying. Interrupted planning requires Retry. Running boards resume on the next poll after a restart.

Claims survive restarts and deletion, so a completed issue is not processed again while its label remains. Removing the label or closing an active issue stops its board on the next poll. Pausing a watcher pauses polling and PR publication; it does not stop a board already running. Repository and checkout are fixed after creating a watcher. A watcher with active work cannot be deleted; pause it instead. Records are stored under `scheduler-runs/github-watch/`.

## Custom automations

Write what the agent should do each run, then choose when:

- **On a schedule** — type it in plain words or cron: `every 5 minutes`, `hourly`, `daily at 6pm`, `weekdays at 9am`, `mondays at 8`, `tuesdays and thursdays at 14:30`, or `0 9 * * 1-5`. The setup shows what it understood and the next run time. Intervals must be at least one minute. Cron uses your local timezone.
- **Only when I run it** — the automation runs from **Run now** only.

Choose the workspace (it defaults to the open workspace; **Use the Scheduler workspace** switches to a private folder in your Minnow home), the mode, and the model. **Menubar default** uses whichever model you last chose in a chat when each run starts; pick a model to pin it. **Run once now** creates the automation and starts it immediately.

## Writing instructions that work unattended

Nobody is there to answer a question or approve a tool. That changes how you write:

- **Be explicit about the output.** "Run the test suite and write a three-line summary naming any failing files" beats "check the tests".
- **Check your permissions first.** Runs use your global permission mode. An action that needs approval returns an error instead of waiting. See [Tools and permissions](../concepts/tools-and-permissions.md).
- **Provide the needed inputs.** Questions cannot be answered during a run; `ask_question` returns a non-interactive error. Browser tools that require the desktop browser are unavailable.
- **Say where results go.** "Append findings to a Brain page called *Nightly build*" gives you something to read tomorrow. Otherwise the output lives only in the run.
- **Set the workspace deliberately.** Wrong workspace means the right instructions operating on the wrong files.

The Custom setup checks the first three as you type.

## Run history

Each automation keeps its last 20 runs: start and finish times, status (running, completed, failed, timed out, stopped), whether it had nothing to do, and the transcript. Transcripts of reviewer runs are kept with their PR Reviewer run. Run history keeps the most recent 16,000 characters of output and errors.

Failed runs appear in **Needs you** and in the hub's activity. **Settings → General → Notifications** controls sounds and desktop delivery; quiet runs never notify.

Automations live in `scheduler.json`, runs and transcripts under `scheduler-runs/` in your Minnow home.

## Automations or `/loop`?

| | Automations | `/loop` |
|---|-------------|---------|
| Runs in | A headless run | One chat, keeping its context |
| Needs | Minnow open | Minnow open **and** that chat idle |
| Good for | Reviews, checks, syncs, reports | Iterating on something until it is right |
| Keeps history | Yes, per run | It is the conversation |

See [Skills and slash commands](../chat/skills-and-commands.md).

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Never ran | Was Minnow open? Is the automation switched on? Is it set to **Only when I run it**? |
| Runs but does nothing | Open the run and read the transcript. Did it reply `NOTHING_TO_DO`? Is a needed action blocked by your permission mode or unavailable in a headless run? |
| PR Reviewer skips every PR | Each PR already has comments and **Skip PRs that already have a comment** is on, or another agent claimed them first. The PR list shows the reason. |
| GitHub preset fails at once | The checkout's origin must point at the repository on GitHub.com, and `gh auth status` must succeed. |
| Failed | Read the run. Does the model still exist? Does the workspace still exist? |
| Touched the wrong files | The workspace on the automation |

## Related

- [Tools and permissions](../concepts/tools-and-permissions.md)
- [Models app](models.md)
- [Troubleshooting](../reference/troubleshooting.md)
