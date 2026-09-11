# Super Plan v3 — server-run pipeline and planning workspace

**Date:** 2026-09-11
**Goal:** Make Super Plan reliable end to end and turn its surface into a real planning workspace.

## Why v3

The v2 engine (`super-plan-server-side-run-engine.md`) passed its own tests but did not work in the app. The two runs in `~/.minnow/superplan/` show it:

| Run | What happened |
| --- | --- |
| `turn-this-demo-…-5dfab281` | The interview lease "crashed" 46 s after it started, again 11 min later, then the user cancelled |
| `transform-the-existing-demo-…-223d72c9` | The interview asked a question, the lease expired 50 s later and the answer came back as a timeout; the user skipped the interview, got a spec that was the raw prompt titled "Build specification", research finished in 16 ms with "No information could be gathered", and the draft lease was never claimed for 24 min |

Confirmed defects, in order of damage:

1. **The renderer claim loop never starts.** `startSuperPlanClaimLoop` has no caller, so a delegated stage that follows a headless one (draft after research) is never claimed.
2. **Delegated leases expire under normal use.** Interview and draft ran as renderer chat turns kept alive by a 10 s heartbeat with 45 s expiry; a throttled or busy window loses the lease and the question the user is reading.
3. **Checkpoints are fatal.** A spec, accept or interview question left for an hour appends `gate.expired`, which finishes the run. Two "request changes" at acceptance fail the run. Pausing three times at a checkpoint fails it.
4. **Research uses the raw library binding** (`minnow-library` / `gguf:…`) and accepts an empty report as success.
5. **Headless stages advertise fake tool schemas** (every tool described by its own name with a generic `path` argument), use a one-line system prompt, ignore the shipped reviewer prompt, and treat a missing report as a skip.
6. **Prompts contradict each other.** The mode prompt says the interview must not write the spec; the stage message says it must. An interview without a spec fails the run outright.
7. **Skipping the interview writes the raw prompt as the spec** and titles the plan "Build specification". Confirming copies the spec instead of moving it.
8. **The UI is a stale projection.** `chat.superPlanView` only refreshes when the user clicks something; the page shows the legacy ten-stage model, two competing sets of checkpoint controls, and buttons (Skip on a failed run) the server rejects.
9. **Research zombies.** A research record left `running` by a restart is polled forever.

## Decisions

- **Every stage runs on the server.** Interview, draft, review and polish are in-process `runTurn` attempts; research uses the Research store. There are no leases, no claim loop and no renderer chat turns. Runs continue with the window closed and survive restarts.
- **Checkpoints are state, not attempts.** The spec and accept checkpoints make no model calls and never expire. Interview questions are journaled; they survive pause and restart and are answered from the page.
- **Failures halt, they do not end.** A required stage that fails three times halts the run (`stopReason: 'halted'`) with the error and a Retry. Optional stages (research, review, polish) are skipped after three failures. Only Cancel is terminal.
- **The user can iterate without limit.** Spec: confirm or request changes with notes. Plan: accept, request changes with notes, or run another review round. An accepted plan can be reopened with new notes.
- **One effector.** `effector.js` routes by role; the fold owns attempt identity through an epoch so user interventions (rework, skip, retry) replace a running attempt immediately.
- **Server-owned prompts and tools.** Stage prompts live in `server/super-plan/prompts/`; tools come from `headlessToolDefinitions`; each stage may write only its own artifact.
- **The page is a view of server state.** It subscribes to the run's SSE stream and refetches state on journal events; a background poll keeps sidebar and library rows current.

## Pipeline

`interview → spec checkpoint → research? → draft ⇄ review (N rounds) → polish? → accept checkpoint`

| Stage | Runs | Writes | Notes |
| --- | --- | --- | --- |
| Interview | Planner model | `references/<slug>-spec.md` | Explores the repo, asks batched structured questions (budget from config; 0 when the interview is off), writes the spec. "Stop asking" makes it write the spec with what it has |
| Spec checkpoint | — | — | Confirm, or request changes with notes (re-runs the interview in revise mode) |
| Research | Research model | `references/<slug>-research.md` | Deep Research with the spec as the brief; an empty report skips the stage with a note |
| Draft | Planner model | `documentation/plans/<slug>.md` | Board format; validated (headings, no implementation fences, `parsePlan` for task plans); validation errors re-seed the same transcript |
| Review | Reviewer model | — | Structured findings (`blocker`/`warn`/`info`, suggested fix, paths). Blockers and warnings trigger a revision; exits on clean, round cap or no progress |
| Polish | Planner model | plan | UI-facing plans only (`auto`), or always/never |
| Accept checkpoint | — | — | Accept, request changes with notes, or review again |

The slug is fixed when the first valid spec lands: its `#` title becomes the file name (the interim `references/<runId>-spec.md` is moved, not copied).

## Server

- `events.js`, `derive.js`, `plan.js`, `policy.js`, `graph.js` — pure core. Legacy v2 events still fold so old journals read as finished.
- `effector.js` — single effector; `agent-stage.js` runs interview/draft/review/polish; `research.js` runs research.
- `ask.js` — journaled questions with no timeout; a resumed interview answers a dangling `ask_question` call from the journal (waiting if the question is still open).
- `artifacts.js` — paths, validation, slug assignment and file moves; `no-code-guard.js`.
- `transcripts.js` — one transcript per stage iteration (`<stage>-<n>.jsonl`), continued across crash/pause retries.
- `middleware.js` — `POST /api/super-plan` (create + start), `GET /runs`, `GET|DELETE /plans` (the library's plan files), per-run `state`, `events` (SSE, follows the run's engine across reopen), `transcripts[/key]`, `pause`, `resume` (also retries a halted stage), `cancel`, `skip`, `rework`, `questions/:id/answer`, `questions/close`, `checkpoint`, `rename`, `DELETE`.
- `projection.js` — the page view and the small `chat.superPlanView` summary.

## Renderer

- `src/chat/super-plan/api.ts` (HTTP), `store.ts` (views, SSE, poll, `chat.superPlanView` sync, one alert per ask), `client.ts` (actions used across the app), `plan-library.ts` (runs from chats plus plan files from the server).
- `src/ui/super-plan-entry.ts` decides which chat and run the surface shows, owns `#chatArea` while it is up, and turns page intents into actions (start, delete, hand-off). A Super Plan chat is the home of one run; a chat that already owns a run never gets a second one.
- `src/ui/super-plan-page.ts`: rail (library), composer (chips read the saved settings), saved-plan view; run mode mounts `src/ui/super-plan/run-pane.ts`: header, `checkpoint.ts` (questions / spec / accept / halted / done), tabs for Activity (`activity.ts`: stage transcripts with a live tail and the user's decisions between them), Spec, Research, Plan and Review (`review.ts`), and the pipeline column with Redo and Skip.
- `src/ui/orchestrate-plan-screen.ts` and `plan-progress-screen.ts` serve regular Plan mode only.
- Removed: claim loop, delegated report/ask hooks in `run-turn-chat.ts` and `tools/client.ts`, legacy ten-stage types, the PlanActivityCollector, the old gate and transcript widgets.
- No looping animations on the surface: runs are long and a running animation costs local model throughput.

## Verification

- Pure fold/plan tables for every transition, checkpoint and intervention.
- Engine conformance with a scripted effector: crash/reload, pause/resume, rework replacing a live attempt, halted retry, quiescence.
- Agent stage against a fake streaming provider with real tool dispatch: interview asks, is answered, writes the spec; draft validation rejects and re-seeds; review findings loop; dangling-question resume.
- HTTP/SSE route tests; UI tests for the page states.
- A sandboxed full-stack run (`MINNOW_HOME` in the scratchpad) driven through the browser pane against a scripted model server: a halted interview retried after the endpoint was fixed, questions answered from the card, spec confirmed, draft ⇄ review with a blocker and a clean round, changes requested at acceptance (an unchanged revision is rejected and halts, as designed), acceptance, rename, and "review again" on the accepted plan across a server restart.

It found and fixed five things the unit tests could not: composer chips that showed built-in defaults and could overwrite saved settings on the first edit; a plan library that depended on the model's `find_files` permission; an events stream that went silent after a finished run was reopened; closing the surface bouncing straight back when every chat was a plan; and a reload on `#/app/code/super-plan` dropping the surface.
