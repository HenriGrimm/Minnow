# Super Plan run engine

Every stage runs on the server. A run is a pure fold of `~/.minnow/superplan/<runId>/journal.jsonl`; the page is a view of that state. Plans continue with every window closed and resume after a restart.

## Pipeline

Interview → spec checkpoint → research (optional) → draft ⇄ review (N rounds) → polish (optional) → accept checkpoint.

- **Interview** explores the workspace, asks batched `ask_question` cards (budget from config; 0 writes the spec without asking) and saves `documentation/plans/references/<slug>-spec.md`. The first valid spec's `#` title becomes the run's slug; the interim file is moved, not copied.
- **Research** runs Deep Research through the Research store with the spec as the brief. An empty report is recorded as empty, not written, and the draft proceeds from the spec.
- **Draft** writes a board-ready plan to `documentation/plans/<slug>.md`; it must parse with `parsePlan`.
- **Review** is read-only and reports structured findings. Blockers and warnings drive a revision; the cycle ends clean, at the round cap, or when a round repeats the previous one.
- **Polish** revises interface tasks (`auto` runs it when the plan has UI work).
- **Checkpoints** make no model calls and never expire. Spec: confirm or revise with notes. Plan: accept, revise with notes, or review again — without limit. An accepted plan can be reopened.

## Modules

| Module | Role |
| --- | --- |
| `events.js` `derive.js` `plan.js` `policy.js` `graph.js` `projection.js` | Pure core: vocabulary, fold, scheduler, failure policy, engine graph, views |
| `effector.js` | One effector per run; routes a role to its stage runner |
| `agent-stage.js` `prompts.js` `prompts/*.md` | Agent stages through `runTurn` with real tool schemas, stage prompts, a per-stage write guard and structured report tools |
| `ask.js` | Journaled interview questions, answer formatting, resume of a dangling question |
| `research.js` | The research stage |
| `artifacts.js` `no-code-guard.js` | Paths, validation, slug choice and moves |
| `transcripts.js` | One transcript per stage step, continued across retries |
| `journal.js` | Journal binding and the chat summary write-back |
| `middleware.js` `live-events.js` | HTTP, SSE and the boot scan |

The purity rules for the core are: **No I/O**, **No clock, no randomness**, and **No imports outside this directory**. `test/super-plan/core-purity.test.mjs` enforces them.

## Durable contracts

- The fold owns attempt identity. Pause, cancel, skip and rework end the live attempt in the fold and bump the epoch in the engine task id, so the engine stops the old work at once and any late end is ignored.
- A reaped attempt (restart) is `interrupted`: it continues from its transcript and does not count as a failure. Crashes, timeouts and rejected work retry up to three times with the same transcript; then optional stages are skipped and required stages halt the run. A halted run is resumable with a fresh budget.
- Questions are journaled before the model waits and have no timeout. A resumed interview answers its dangling `ask_question` call from the journal, waiting for the user if needed; answering while paused resumes the run.
- Artifacts are checked when saved (the tool result warns) and when the stage ends (failures re-seed the transcript with the errors). A stage may only write its own artifact.
- The configuration and model bindings are snapshotted on `run.created` (`config.engine: 3`). v2 journals fold read-only as finished or halted.

## HTTP

`POST /api/super-plan` creates and starts a run. `GET /api/super-plan/runs` lists summaries. `GET /api/super-plan/plans` lists the plan files in the requesting view's workspace and `DELETE /api/super-plan/plans` removes one (markdown under `documentation/plans/` only), so the library never depends on the user's tool permissions. Per run: `GET state`, `GET events` (SSE: `view` on every change, `live` for streamed output and research progress), `GET transcripts`, `GET transcripts/:key`, and `POST pause`, `resume`, `cancel`, `skip`, `rework`, `questions/:id/answer`, `questions/close`, `checkpoint`, `rename`; `DELETE` removes the journal.

An events stream follows its run's engine wherever it comes from: a stream opened on a finished run attaches when a rework or a reopened checkpoint loads the engine again.

## Verification

`test/super-plan/` covers the pure fold and policy, engine conformance, and the full pipeline over HTTP with real `runTurn` and tool dispatch against a scripted model (questions, pause and resume, halts, empty research, revisions, skip and rework).
