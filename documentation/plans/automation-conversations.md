# One ongoing chat per automation

## Goal

An automation has one conversation in Code. Scheduled runs and **Run now** add to it, and users can follow up in the same conversation. Archiving or deleting the chat gives the next run a fresh conversation. Users can still select an individual run in Automations to see its status and inspect its work.

## Product behavior

- Create the chat when the first run starts and open it from the automation header with **Open chat**. Use the automation name as the initial chat title. Show an automation label in Code with a link back to its settings and run history.
- Show each run as a dated entry with its trigger, status and result. Link from the entry to the exact run in Automations. Keep routine **Nothing to do** entries collapsed, with the existing quiet notification behavior. Human follow-ups appear as ordinary turns.
- A scheduled prompt run gets the current automation instructions, recent relevant follow-ups and the latest meaningful successful result from this conversation. The user can scroll through the conversation and inspect earlier tool activity. Durable instruction changes go through **Edit automation**. A reply asking for standing guidance can point there, and a normal reply never saves a config change on its own.
- Archive ends the automation’s association with that chat as soon as it commits. An admitted run can finish in the archived chat. The next run creates a new chat. Restoring the archived chat makes it readable and usable in Code as usual. It stays detached from the automation even when restored before the next run.
- Delete uses the existing chat deletion behavior. If active work must stop first, show the existing Stop flow. Once deletion commits, the next run gets a new chat ID and an empty conversation. The schedule, configuration, run history and PR/issue ledgers stay with the automation. Explain in the archive and delete UI that both actions reset the conversation and that run history remains in Automations.
- If a prompt automation is due while a user turn occupies its chat, leave one run due for the next idle opportunity. Show **Waiting for chat** and keep repeated clicks or ticks from creating multiple pending runs. Use the same behavior for **Run now**, including manual-only jobs. A user follow-up during a running prompt automation uses Code’s normal queue.

## Implementation

### 1. Chat identity and reset

Use the managed chat repository to create an ordinary Code root for an automation. Keep the active job-to-chat association in SQLite beside the chat so chat creation and binding can commit together. Give the job one current binding and give each new conversation a fresh ID. Store enough identity to verify the job and workspace before use. Keep the live association internal to the server and expose its resolved chat ID through Scheduler reads.

- Update the binding at the committed archive/delete boundaries. Cover both managed chat commands and any trusted session write path that can change archive or delete state. Resolve a missing, archived or mismatched binding before new admission. Recheck the binding in the admission transaction so a pending tick cannot append to a chat archived during preparation. A restored chat never reclaims the binding. A late completion keeps its original run and conversation IDs.
- Keep run IDs independent of conversation IDs. Put the associated chat ID and, for model turns, the command and execution IDs on each run as they become available. Existing per-run Code chats and links remain usable. Upgrade lazily at an existing automation’s next run, with no import of its old turns into the new conversation.
- Rotate the chat if the automation moves to a different workspace. Verify the actual project and checkout with the shared chat scope rules. Keep schedule, name, model and instruction edits on the same conversation in the same workspace. Deleting the automation removes its binding and follows the existing Scheduler deletion rules. Its Code conversation remains accessible through the normal chat lifecycle.
- Cover full backup/restore and chat-only export/import. Restoring a scheduler and session backup together preserves valid bindings. A missing half is handled on first use. Importing a conversation on its own gives the user its history without creating or reattaching a live automation.

### 2. Prompt runs through managed chat

Add a private Scheduler admission path through the managed command service. It creates or reuses the bound chat, snapshots the job’s effective settings, and admits one scheduled command keyed by the Scheduler run ID. Scheduler owns timing and records, and the managed chat runtime owns the turn and its transcript.

- Capture the job’s instructions, resolved model and work agent for each run, including the existing Menubar default policy. Use scheduled-run provenance in the transcript and Activity. `--chat-id` alone currently switches existing chats to their saved model and interactive command path, so it cannot preserve the Scheduler contract by itself.
- Keep unattended policy on that command. Apply current global permissions and workspace checks at effects, reject or exclude interactive questions, approvals and browser-only effects, and preserve the current guidance about routine memory writes. Apply the unattended rules to downstream execution covered by that run. Ordinary human follow-ups in the chat continue to use normal interactive policy. Derive the scheduled role from trusted admission, with no way for a public send payload or client header to claim it.
- Select model context explicitly for scheduled turns. Include current instructions, a bounded window of human follow-ups and the last meaningful successful result from the current conversation. Skip quiet runs and tool traces by default. Use the shared context budget and keep tool calls in the current turn paired with their results. Ensure provider-native turns honor the same reset and context rules, including providers that retain their own sessions. Human turns use the regular chat context path.
- Check for a busy chat before taking an execution slot and again at admission. Keep a single durable waiting request per job, including manual-only jobs, and retry at the next idle opportunity. Resolve the current binding and settings when it is admitted. Pausing clears a waiting schedule trigger, and an explicit **Run now** remains available for paused jobs. A recovery barrier follows the existing chat recovery flow. Keep per-job mutual exclusion and the global Scheduler concurrency limit.
- Correlate Scheduler activity and notifications with the managed turn so one run produces one Activity item. Persist the Scheduler run identity before admission. Look up the managed receipt by that identity on restart, including when the server accepted the command before Scheduler saved the response. Stop and timeouts target the exact command or execution, including any work it started. Restart recovery settles the interrupted run using its saved state. Keep per-run tool calls and transcript detail available in Automations.

### 3. PR Reviewer and Issue Watcher

Use the same bound Code conversation for both presets. Publish the top-level run’s status, findings and links as a dated entry through the canonical chat repository. Use the run ID to make publication idempotent and publish without starting model inference.

- Keep review lenses and issue planning scoped to their worktrees. Keep their detailed output in Automations, with board and PR links in the chat entry. Issue Watcher currently saves a separate Code chat for some planning runs. Move new planner transcripts to run detail alongside reviewer transcripts and retain existing links for older runs.
- Publish a run’s result to the chat it was admitted against. If that chat was deleted before publication, retain the outcome and exact transcript in Scheduler history. The replacement chat starts with empty history.
- Keep PR and issue ledgers as the authority for claims, deduplication, retries and board progression. Archive or delete resets the conversation without reopening processed work. A follow-up in Code can discuss an outcome. Preset behavior changes through its automation settings.

### 4. UI and documentation

- Add the stable **Open chat** action and a pending state before a chat exists. Keep run selection, stop, retry, reviewer drill-down and board links in Automations. The run view keeps historical links to the chat or output associated with that run, including readable archived chats and a run-detail fallback for deleted chats.
- Render scheduled entries through the shared chat renderer, with timestamp, status, quiet folding and a deep link to the run. Verify the sidebar contains one current conversation across repeated runs. Reuse Code’s composer, archive, restore and delete controls.
- Update the Automations manual and `documentation/context.md` on implementation. Document what carries across runs, what a reset clears, and what remains in run history. Update the `/loop` comparison to cover in-conversation iteration and independent Scheduler timing.

## Acceptance checks

| Scenario | Expected result |
| --- | --- |
| Two scheduled runs, **Run now**, and a human follow-up | One Code chat, three distinct run entries and exact run links. The next run can use the follow-up within its context budget. |
| Archive and restore before the next run | The next run opens a fresh chat. The restored chat remains accessible and detached. |
| Archive during an active run, or delete after stopping it | The original run settles against its original identity. The next run uses an empty conversation. Scheduler history and ledgers are still available. |
| Tick and **Run now** race while the chat is busy | One pending run, no duplicate chat or scheduled turn, and no interruption of the human turn. |
| Stop, timeout or restart with a scheduled command in flight | The saved receipt identifies the original run. No duplicate tool effects or cancellation of a different turn. |
| Configuration or workspace changes | Updated instructions and model take effect on the next run. A workspace change opens a fresh chat in that workspace. |
| Quiet, failed and stopped runs | Statuses and tool details remain inspectable. Quiet runs do not notify, and failed output does not become the next run’s default context. |
| PR Reviewer and Issue Watcher across several items | One chat per job, exact run details and working links. Resetting the chat does not repeat reviewed commits, claimed issues or completed boards. |
| Upgrade, partial restore and chat-only import | Old run links still resolve where available. A missing binding is repaired by creating a fresh chat. Imported history never starts scheduled work. |
| Unattended approval and human follow-up in the same chat | The run follows unattended policy, and a human turn can still use the normal approval and question controls. |

Cover the binding and admission races in the chat repository and Scheduler tests, the unattended behavior and receipt recovery in the managed execution suites, and the user-facing paths in `test/os/scheduler-app.test.mts` and the existing Code chat suites. Check the production bundle with `npm run headless:build`, run `npx tsc --noEmit`, and smoke-test consecutive runs and reset in Electron with a fake provider and an isolated Minnow home.
