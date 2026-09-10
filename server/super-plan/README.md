# Super Plan run engine

The server owns sequencing and recovery. State is a pure fold of `~/.minnow/superplan/<runId>/journal.jsonl`; renderer state is a display projection.

## Execution

Interview → specification gate → optional research → draft ↔ review → optional polish → acceptance gate. Gates make no model calls. Interview and draft run through a renderer lease; research uses the existing Research store; review and polish run headlessly through `runTurn`. The shared production effector factory is used at creation and boot.

The purity rules are: **No I/O**, **No clock, no randomness**, and **No imports outside this directory**.

The graph modules (`events`, `derive`, `plan`, `policy`, `graph`) perform no I/O, read no clock/random source, and import only their pure siblings. The core purity suite enforces this boundary. The shared orchestrator engine and runner remain unchanged.

## Durable contracts

- Questions are appended before delivery. Answers carry a gate and attempt id; late answers cannot advance a replacement attempt. Expiry is terminal; aborting while paused does not finish the run.
- A renderer claims one attempt using compare-and-set ownership, then heartbeats. Unclaimed leases wait; claimed leases expire after lost heartbeats. Stale completion is rejected, duplicate successful completion is idempotent, and the client stops generation when it loses ownership.
- Artifacts are checked under `documentation/plans/`. Draft acceptance checks structure and progress against the preceding content hash; executable task plans also pass the board parser. Artifact facts and attempt completion append as one batch.
- Review requires a structured findings array (empty is valid). Stable finding identities drive bounded iterations, no-progress detection and disputed claimed fixes. Optional-stage exhaustion advances; draft exhaustion fails the run.
- The configuration and model overrides are snapshotted at creation. `polish: auto` uses the request and journaled draft UI signals.
- Headless role transcripts checkpoint to `transcripts/<role>.jsonl`. Interrupted research starts a continuation using the persisted Research id. The boot scan isolates unreadable runs so other runs still recover.
- `chatId` links the run to `superPlanView` in chat metadata. Session import retains the newer projection; normalization retains gate and progress fields. The journal remains authoritative.

## HTTP and UI

`POST /api/super-plan` creates a run. Per-run routes provide `GET state`, `GET events` (SSE), and `POST start`, `stop`, `resume`, `cancel`, `claim`, `finish`, `ask`, `gates/:gateId/answer`, `skip`, `rework`.

Stop pauses; resume continues; cancel is terminal. Rework explicitly reopens a role. SSE shares one connection per visible run between client consumers. The claim loop reconciles after boot, stream completion and on a timer. The renderer never decides the next pipeline stage. Historical chat-only state is retained for compatibility but has no executable controller.

## Verification

`test/super-plan/` covers pure folding/policy, engine conformance, crash recovery, gate ordering and expiry, leases, HTTP/SSE, a full production-effector pipeline, the real runner with a fake streaming provider and real file tool dispatch, research continuation, and session projection. UI suites cover restored progress and the plan surface. External model quality and provider availability are outside deterministic tests.
