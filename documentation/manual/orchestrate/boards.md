# Orchestrate boards

A board runs a plan through builders, independent testers, isolated Git worktrees, merging, and final integration checks.

## Start a board

Open **Orchestrate** from Code, choose a plan under `documentation/plans/`, and open the board. Select a starting branch and a model, then press **Start**.

Each task in the plan names its Build, Test, Accept, Touches, and Depends on requirements. Waves organize cards; explicit dependencies determine readiness. For a fresh project, make the scaffold a prerequisite of tasks that need it.

If the plan does not parse, **Repair** opens a planning chat to correct the named schema or dependency errors and retries opening the board.

## Execution controls

| Control | Behavior |
| --- | --- |
| **Start** | Starts eligible work up to the concurrency cap and enables automatic recovery |
| **Pause** | Holds live conversations at model/tool boundaries; Resume continues those attempts |
| **Stop** | Ends current attempts and prevents automatic resumption until you start the board again |
| **Concurrency** | Limits concurrent tasks; set it to 1 for sequential execution |

Operations already in progress can finish when paused. Paused time does not consume an attempt's wall-clock limit.

Running boards started with automatic recovery resume after Minnow restarts, using their recorded workspace. Explicitly stopped and paused boards stay held. Older boards retain their previous startup behavior until explicitly started with the current recovery policy.

## Automatic recovery

Failed attempts retain their task checkout. Repairs continue from existing work and the recorded failure. Isolated failed attempts also preserve recoverable checkpoints, including newly created files and the distinction between staged and unstaged changes.

Board backups include these source checkpoints and require a passphrase. Temporary engine ownership files are excluded from backups.

After verified completion, Minnow reclaims clean merged task checkouts and their recovery copies. Unresolved work, waived tasks and checkouts with later edits remain retained. The integration branch keeps merged source.

Temporary provider outages, rate limits, quota resets and host capacity pressure enter a wait. The board resumes automatically when eligible. These waits do not consume code-repair attempts. Healthy work already running continues, and unrelated eligible tasks can progress.

Repeated implementation failures trigger a focused diagnostic attempt before the remaining repair attempts. Minnow retains acceptance requirements and stops spending attempts when the configured repair budget is exhausted.

A final typecheck, lint, test or build failure creates a separate integration repair task. After that task is tested and merged, final checks run again. Original unfinished tasks retain their own scope.

## Action needed

Credentials, unavailable devices, missing reference files, unsupported verification capabilities and exhausted repair budgets can require your action. The board shows the specific prerequisite and retains its progress.

Minnow automatically checks supported file, executable, local service, browser and CLI prerequisites. Once they are ready, the board continues. For an uncheckable prerequisite, resolve it and choose **Check again**. There is no additional Start or Rerun step. For a budget hold, increase the corresponding limit in **Settings → Autopilot**, then check again. Changing the board model re-evaluates affected provider holds.

A missing recorded workspace stays held instead of running in another project. Reconnect the original directory to continue.

## Verification and completion

The tester independently runs the task's required checks. It reports **fail** for an observed defect and **blocked** when a required check cannot run. Required browser behavior needs executable browser verification; inspecting source does not establish rendered behavior.

Required verification IDs derive from the task's Test and Accept specifications. A passing report accounts for each ID with evidence, and approval is tied to the tested commit. Editing the task changes its verification contract.

List existing reference files in a plan's **Inputs** section using backticked workspace-relative paths. Minnow copies those declared files into the isolated board and commits them there. Missing inputs hold setup; the original workspace is not staged or committed.

A rebase that changes tested content returns the task to testing before merge. Final checks apply to the current integration revision.

A board completes when required tasks are merged and final verification passes. Explicit user waivers are recorded and displayed as **Completed with waivers**. An abandoned or stranded task is incomplete, even if other final checks passed.

## Inspect work

Click a task to inspect its specification, attempts, commands, reports and file changes. The integration branch contains the assembled result; task worktrees isolate ongoing edits.

Use **Retry**, **Reset**, **Rewind**, **Skip**, or **Merge and skip** only when you deliberately want to override normal recovery. Reset discards the selected unmerged task's runtime work. Rewind restores integration to an earlier point and resets affected later work. Skip records a waiver; it does not verify the omitted requirement.

## Limits and models

The header's model and reasoning settings apply to new attempts. Active attempts keep their selected settings. Recovery uses the existing provider routing and eligible model pool.

**Settings → Autopilot** controls build/test repair allowances, final repair rounds, a board-wide recovery budget, and the per-attempt wall-clock limit. Waiting for resources does not spend the code-repair budget.

Recovery does not expand tool permissions or authorize publishing. Review the integration result before committing, pushing or opening a pull request.
