# Orchestrate boards

A board turns a plan document into a kanban of tasks that agents work through — building, testing, fixing and merging — while you watch or while you are away.

This is the most powerful thing in Minnow and the one that most rewards understanding before you press Start.

## The shape of it

1. You write a plan in [Plan mode](../concepts/modes.md) into `documentation/plans/`.
2. An **orchestrator** reads it and creates a board of tasks. **Waves group cards**; start order is each task's **Depends on** list — later waves do not wait automatically.
3. Each task gets its own chat and its own agent: a **builder** implements it, a **tester** verifies it, a **fixer** repairs failures.
4. Completed work merges into an integration branch.
5. A **final integration test** runs across the whole board.
6. A finish report offers to commit, push, and open a pull request.

You choose how much of that happens without you.

## Starting a board

Open the **Orchestrate** button in the Code sidebar rail. The hub shows your recent boards and lets you pick a plan.

Choose a plan file and Minnow creates an Orchestrate planner chat, checks the workspace is a git repository (offering to set one up if not), and asks the orchestrator to build the board. While that is happening the folder shows **Setting up**; if you navigate away there is a banner to return.

Plans must live under `documentation/plans/`. Plan mode can write there even though it cannot touch the rest of your repository — that is deliberate, and it is how a planning session hands off to a delivery board.

On a **fresh project**, put scaffold in **Wave 1 alone**. Every later task lists that id under **Depends on**. Boards do not wait for earlier waves.

If the plan does not parse, Boards lists the errors and offers **Repair**. Repair opens a **Repair plan** chat in the sidebar that edits just the broken parts of that file to match the required schema (same waves and tasks); when its turn finishes, Boards opens the board. You can open that chat to follow along or keep talking to it.

## The board

The header is one instrument strip: plan title, status badge, and telemetry — tasks, waves, run, elapsed — over a thin progress bar, then the run controls.

Cards move through these states:

| Status | Meaning |
|--------|---------|
| **Planned** | Not started |
| **In progress** | A builder is working |
| **Testing** | A tester is verifying |
| **Merging** | Result is being integrated |
| **Complete** | Done and merged |
| **Failed** | Attempt failed; retry logic applies |
| **Blocked** | Waiting on a dependency |
| **Quarantined** | Parked after exhausting retries — needs you |

Waves collapse and expand. Click a card to open that task's chat and read exactly what its agent did.

Keyboard: **Tab** moves between cards and header controls, **arrow keys** move around the grid, **Enter** or **Space** opens a task.

## Execution modes

The most important control on the board. Four stops, least to most autonomous:

| Control | Behaviour |
|---------|-----------|
| **Running** | The board starts eligible work up to the concurrency cap, unattended |
| **Stopped** | Nothing new starts unless you start a task by hand (Manual) |
| **Concurrency** | How many tasks may start at once. Set to 1 for sequential |

Running at concurrency 1 is sequential. Running at a higher N is parallel. Stopped plus per-task start is Manual.

**Stop** freezes the board immediately. A board paused by a shutdown or a memory-recovery event stays Stopped until you press Start.

## Worktree isolation

Parallel agents editing one checkout is a recipe for a mess. Isolation gives each task its own **git worktree** — a separate checkout and branch so merges stay orderly. That is **git isolation**, not OS host containment: a shell on Full can still reach paths outside the worktree unless the agent shell sandbox is enabled.

| Setting | Behaviour |
|---------|-----------|
| **Auto** | Derived from concurrency: off at 1, per-task above it |
| **Off** | Everyone shares the workspace |
| **Per-task** | Every task gets its own worktree |
| **Per-wave** | One worktree per wave |

With isolation on, Minnow mints an **integration branch** and merges task branches into it as they complete. While board view is active, the file explorer, terminal and source-control panel follow the **integration** worktree, not any one task's — so you are looking at the assembled result. Open a task chat and you see its own checkout.

Leave this on Auto unless you have a reason. Running several tasks without isolation means several agents writing to the same files at once. Worktree isolation and the shell sandbox (when available) solve different problems — use both when you care about both.

## Model and concurrency

The board header has its own model chip. It sets the model for the planner and every task chat on that board, so you can run a board on a different model from your normal chat — and change it mid-run.

Concurrency sets how many task chats run at once. More is not always faster: every concurrent task is a full agent loop competing for the same provider, and a local runtime serving one model will serialize them anyway.

## When things fail

Boards are built around the assumption that agents fail, so the interesting behaviour is in the recovery:

- **Test failures** reopen the task for a fixer instead of failing the board.
- **Context-length errors** are treated as transient — a tester that overflows retries without burning a test attempt.
- **An agent that forgets to report** gets nudged; if it keeps failing to report, the task is quarantined at the build cap rather than spinning.
- **Quarantine parks a task and its dependents** so the board does not pretend to make progress. Use **Requeue** to try again.
- **Self-heal** can attempt rounds of automatic repair before quarantining, configurable under **Settings → Agents → Autopilot**.

Every board writes a diagnostic log of status changes, verdicts, merges, retries and slot accounting, so a board that went wrong can be read after the fact.

## Finishing

When every task is complete, a **final integration test** runs across the whole board. It is the check that the parts work together, which per-task tests cannot tell you.

The final test runs typecheck, lint, unit tests, and build commands; its automatic browser check is disabled. Board agents do not receive Minnow's built-in browser tools. Each builder or tester attempt has a wall-clock limit, 240 minutes by default, set under **Settings → Agents → Autopilot → Attempt time limit** (`0` turns it off). An attempt that hits it ends as timed out and is retried or abandoned like any other timeout. Stop still cancels an active attempt, and model or command failures can still end one.

Then the **finish report** replaces the kanban, as a full-width dashboard. A row of tiles carries the run's counts — merged, abandoned, skipped, runs, files, lines, and whether the integration check passed. **Needs attention** is next: one line per card that did not finish, saying why, with a **Reset task** button on it. Below that is one row per task with its outcome, how many runs it took, and a GitHub-style `+/−` diffstat; open a row for its runs and the files it changed, line counts and all. Run notes and the raw journal stay closed at the bottom.

Its primary action commits the integration work into your branch, and — depending on what your repository supports — pushes it and opens a pull request. There is a caret for **Commit only** or **Commit + push**. **Clean up** removes the board’s worktrees and merged local branches in one action. A notice explains what is deleted, and a progress bar tracks checking worktrees, removing them, and removing branches. If any board worktree has uncommitted changes, cleanup stops and identifies the worktree so you can commit or move the changes first. Branches with unmerged commits or an active checkout are kept, with a reason shown for each. Remote branches are unchanged.

If the run failed, **Retry** reopens abandoned and stranded skipped tasks (merged work stays merged, and cards you skipped yourself stay skipped) and starts the board again. When every task merged but the final test failed, Retry adds a fix task and re-runs the ladder. Retry is always something you press; the board does not loop on its own.

**Reset** and **Rewind** wipe a card so you can run it from a clean slate. They are not Retry: Retry keeps attempt history and never rewinds git.

- **Reset** is on a card that has run but has not merged — attempts, abandoned, skipped, a merge conflict, or sitting in the merge queue. It deletes that card’s attempt history, transcripts, worktree, and attempt branch, and it also wipes skipped cards waiting on it. Integration git is left alone. The card returns to Planned.
- **Rewind** is on a merged card. It restores the board’s integration worktree to the commit from just before that merge, then wipes this card and later merged, started, in-flight, or merge-queued work (and skipped cards blocked by that set). It does not rewind your workspace `main` or `master`.

Neither starts the card again. If the board is already Running, the scheduler may pick the idle work on the next tick.

**Skip** is in a card's actions menu on any card that has not merged. It marks the card done without merging it, so the tasks that depend on it can run. A running agent on the card is stopped. Use it when a task is already done by hand, no longer needed, or abandoned and holding up work you still want. Skipping an abandoned card releases the cards it had stranded.

Skip asks first and lists the tasks that will run without the skipped card's changes: they may fail because work they expect is missing, and the final test may fail too. A skipped card sits in Complete marked **skipped by hand** and does not count as needing attention. **Retry** on the card or **Reset** brings it back, but tasks that already ran without it are not rerun.

Idle cards that have never started keep Start, Abandon, and Skip only.

### Editing a task

A board keeps its own copy of the plan from the moment you created it, so editing the plan file afterwards does not change the board until you press **Sync plan** (below). To change one card, open it and press **Edit** on its **Spec** panel. You can change the title, Build, Test, Accept, and Touches; waves and dependencies stay as they were planned. Saving changes this board only — the plan file is left as it is, and the agents are told the card's spec on the board is the one to follow.

Edit is available on a card that is not running, not waiting to merge, and not merged. Rewind a merged card first. Editing keeps the card's history; press **Retry** or **Reset** afterwards to run a failed or abandoned card with the new spec. An edited card shows **edited** next to its spec.

### Syncing from the plan

After you change the plan file, press **Sync plan** in the board header to bring those changes in. You first see what will change and what will be left alone; nothing happens until you press **Apply**.

- **Changed cards** take the plan's new title, Build, Test, Accept, Touches, wave, and dependencies. If you also edited that card on the board, your edit stays wherever the plan did not change the same field; where both changed it differently, the board's version is kept and the sync says so.
- **New tasks** in the plan are added to the board. They may depend on existing cards or on each other. A finished run reopens so the new work can run; press **Start** (or, if the board is Running, it may start them straight away).
- **Dependencies:** dropping a dependency lets a card start sooner. A card that was skipped only because of a dependency you removed becomes runnable again (and a finished run reopens for it). The sync refuses the whole change if a dependency would point at a task that does not exist or would make a loop.
- **Left alone:** cards that are running, waiting to merge, or merged, and cards you removed from the plan, which stay on the board until you abandon them.

If the plan no longer parses, the sync stops and shows the errors. Syncing never edits the plan file.

Toggle back to the kanban at any time from the header.

## Global defaults

**Settings → Agents → Autopilot** sets the defaults every new board starts with: Running or Stopped, isolation, maximum concurrency, planner model, retries, heartbeat, self-heal rounds, infrastructure provisioning, auto-restart of stalled tasks, and a guard against agents changing directory outside their worktree. Isolation means git worktrees for parallel tasks — not OS host containment.

**Settings → Agents → Watchdog** sets the streaming limits — idle timeout and maximum duration — that stop a hung model from stalling a board indefinitely.

## Board chats are locked

Planner and member chats hide the mode selector, and mode changes on them are rejected. The orchestrator assigns each chat its mode, its work-agent role and its tool set; a task agent cannot quietly promote itself. Undo is also unavailable on board-linked chats.

## Getting good results

**The plan is the product.** A board executes what the plan says. Vague tasks produce vague work, and no amount of autonomy fixes it. Sharpen the idea in [Plan mode](../concepts/modes.md) before you start a board.

**Start Stopped.** Run one task, read what the agent did, and see whether the plan means what you thought. Then press Start, or set concurrency to 1 for sequential.

**Commit before you start.** The board works on branches, but a clean starting point makes everything easier to unwind.

**Watch the first wave, then leave.** Most plan problems show up in the first two tasks.

## Related

- [Agents, sub-agents, and packs](agents.md)
- [Code app](../apps/code.md)
- [Tools and permissions](../concepts/tools-and-permissions.md)
