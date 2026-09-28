# Scheduler

Scheduler runs a prompt on a schedule, without a conversation. Each job is a headless agent run in a workspace you choose with a model you choose — a nightly test summary, a Monday dependency check, a periodic sync of notes into Brain.

Open it from the app rail or the menubar. It opens as a **side panel** and deliberately does not take focus, so you can add a job without leaving what you are doing.

## The one rule

**Jobs only run while Minnow is running.** Hidden in the system tray counts as running — that is the normal case, since closing the window hides to tray by default. Fully quitting stops the scheduler.

Minnow does not install an OS-level scheduled task, and it does not backfill runs it missed while closed. If a job must survive reboots, enable **Launch Minnow at startup** under **Settings → General → Desktop app**.

## Creating a job

| Field | Notes |
|-------|-------|
| **Label** | How it appears in the list and in notifications |
| **Prompt** | What the agent should do each run. Treat it as a full brief, not a title. |
| **Schedule** | Interval or cron |
| **Mode** | The operating mode the run uses |
| **Work agent** | Optional role — researcher, reviewer, and so on |
| **Provider / model** | Which model runs it |
| **Workspace** | The project folder. Defaults to a scheduler workspace in your Minnow home. |
| **Channels** | Where results are announced |
| **Enabled** | Pause without deleting |

### Schedules

**Interval** takes forms like `60s`, `5m`, `2h`. The minimum is **60 seconds** — anything shorter is rejected.

**Cron** takes a standard five-field expression evaluated in your local timezone. Invalid expressions are rejected when you save, not silently at 3 a.m.

| Expression | Meaning |
|------------|---------|
| `0 9 * * 1-5` | 09:00 on weekdays |
| `30 2 * * *` | 02:30 daily |
| `0 */4 * * *` | Every four hours |

The next run is computed from now; missed runs are not queued up and replayed.

## Writing a prompt that works unattended

Nobody is there to answer a question or approve a tool. That changes how you write:

- **Be explicit about the output.** "Run the test suite and write a three-line summary naming any failing files" beats "check the tests".
- **Check your permissions first.** A tool set to **Ask** in an unattended run just stalls. See [Tools and permissions](../concepts/tools-and-permissions.md).
- **Say where results go.** "Append findings to a Brain page called *Nightly build*" gives you something to read tomorrow. Otherwise the output lives only in run history.
- **Set the workspace deliberately.** Wrong workspace means the right prompt operating on the wrong files.

## Run history

Each job keeps its runs: start and finish times, status (running, completed, failed, timeout, cancelled), exit code, output, and errors. Runs persisted as chats can be reopened and read as conversations.

Notifications reach the menubar bell; **Settings → General → Notifications** controls whether background-job notifications appear and whether they make a sound.

Jobs live in `scheduler.json` and runs under `scheduler-runs/` in your Minnow home.

## Scheduler or `/loop`?

| | Scheduler | `/loop` |
|---|-----------|---------|
| Runs in | A headless job | One chat, keeping its context |
| Needs | Minnow open | Minnow open **and** that chat idle |
| Good for | Reports, checks, syncs | Iterating on something until it is right |
| Keeps history | Yes, per run | It is the conversation |

See [Skills and slash commands](../chat/skills-and-commands.md).

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Never ran | Was Minnow open? Is the job enabled? Interval at least 60 s? |
| Runs but does nothing | A tool is probably on **Ask** with nobody to approve it |
| Failed | Run history message. Does the model still exist? Does the workspace path still exist? |
| Touched the wrong files | The workspace on the job |

## Related

- [Tools and permissions](../concepts/tools-and-permissions.md)
- [Models app](models.md)
- [Troubleshooting](../reference/troubleshooting.md)
