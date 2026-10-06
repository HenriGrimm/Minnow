# `server/runner` — shared headless turn loop

Extract of the turn loop (MIN-698 / P2-A; originally
`src/agents/sub-agent-runner.ts`, deleted in P8-G). Plain `.js` + `.d.ts`
so the Node server can import it without a transpile step.

`turn-runner.js` holds the **only** tool loop in the product. Main chat,
orchestrator boards and sub-agents all run through `runTurn()`, which is its
single construction site — `input.type` is the only difference between them
(`'turn'` is main chat). It kept a sub-agent name long after it stopped being
sub-agent-specific; changes here affect every turn in the app.

The package does not know what a board is. Completions, tools, and transcripts
are injected (`RunnerDeps`). P2-C binds completions in-process. P2-D binds
tools in-process (`createInProcessToolDispatch`). P2-E supplies
Builder/Tester report schemas. P2-F maps turn results onto the engine.

## `runTurn()` — Phase 6 contract (MIN-699 / P2-B)

```ts
runTurn({ chatId, seed, tools, model, onEvent }) -> TurnResult
```

**Any change to this signature is a Phase 6 finding and must be recorded as one.**
Phase 6 is "all chat eventually" (locked decision 5). If this entry point learns
what a board is, that phase becomes a rewrite.

`chatId` is an opaque string. The runner never parses it, never looks it up, and
does not require a board (or any other product object) to exist.

### Result shape

The return value is the six-way **object** union from PRD §5.3. It is named
`TurnResult` in this package because `server/orchestrator/core` already uses
`AttemptResult` for the **string** alias (`'pass' | 'fail' | …`). Do not smash
those types together. P2-F maps `result.outcome` onto the core string.

```ts
type TurnResult =
  | { outcome: 'pass';    summary: string; evidence: string[] }
  | { outcome: 'fail';    summary: string; blockers: string[] }
  | { outcome: 'blocked'; summary: string; needs: string[] }
  | { outcome: 'no_report' }
  | { outcome: 'crashed'; error: string; providerUnreachable?: true }
  | { outcome: 'timeout' }
```

- `pass` / `fail` / `blocked` — only from a successful call to the injected
  report tool (`reportToolName`, default `report_outcome`). Returned verbatim.
- `no_report` — the loop ended without a successful report-tool invocation.
  Assistant prose is never parsed to invent an outcome. A *rejected* report
  (malformed payload) is not this: the tool was called, the model can retry.
- `crashed` — unrecoverable error (provider throw, HTTP failure, …) with message.
  `providerUnreachable: true` when the model server refused connections for
  longer than `limits.providerWaitMs` (the runner waits that out first); boards
  treat it as an interruption, not the agent's failure. `limits.maxRepeatedToolCalls`
  also ends a turn as `crashed` when one call keeps returning the same result.
- `timeout` — `limits.wallClockMs` elapsed **or** `limits.maxTurns` was hit.

Malformed report-tool calls are rejected **at execute-time** (P2-E): the tool
result is an error the model can act on, the loop continues, and a later valid
call still produces `pass` / `fail` / `blocked`. Inject `parseReport` for a
role-specific schema; the default parser stays the PRD union and does not know
Builder vs Tester. **Phase 6 finding:** `parseReport` was added to the options
object so a caller can reject without teaching this package a role name.

### Parameters

| Name | Role |
|------|------|
| `chatId` | Opaque correlation id. Transcript key only. |
| `seed` | Opening user message. |
| `tools` | Caller OpenAI function-tool list. `ask_question` is added or stripped by `ask` (not by this array). |
| `model` | `providerId` + `id` + optional sampler / thinking. |
| `onEvent` | Presentation-free typed events (`delta`, `thinking`, `tool_streaming`, `tool_call`, `tool_result`, plus P10-B `phase` / `reasoning_end` / `stream_meta` / `round_start` / `round_end`). The caller chooses DOM, SSE, or nothing. Disk high-frequency types: `isHighFrequencyTurnEvent`. Sub-agent live SSE: `shouldEmitSubAgentLiveTurnEvent` (forwards `phase`). |
| `onRoundBoundary` | **P10-I.** Optional `() => TranscriptMessage[] \| null`. Consulted at the top of every tool-loop iteration; returned rows splice into the in-memory transcript. Same injection shape as `AskCapability`. Chat implements it; board/sub-agent omit it. |
| `cwd` | Forwarded to tool execute context. This wrapper does not `chdir`. |
| `transcript` | P2-A `TranscriptStore`. Falls back to `deps.transcriptStore`. |
| `signal` | Caller abort. Distinct from wall-clock timeout. |
| `limits` | `maxTurns`, `wallClockMs`, context budget, model context limit. |
| `deps` | P2-A `RunnerDeps` — completions and tool dispatch stay injected. |
| `reportToolName` | Injected report tool (default `report_outcome`). Pass `null` to omit. Not a role name. **P6-C.** |
| `injectReportTool` | When `false`, do not append a report tool. Default `true` (board unchanged). **P6-C.** |
| `parseReport` | Optional. How to accept a report payload. Default: PRD union. A `{ ok: false, error }` result is a tool error, not `no_report`. Phase 6 finding. |
| `ask` | **P6-B / MIN-724 (Phase 6 finding, PRD §9).** `{ ask(question, ctx) -> Promise<Answer> } \| null`. Presence of `ask()` puts `ask_question` on the resolved tool list and routes the call to the handler (never through in-process `executeServerTool`). `null` / omitted **strips** the tool even if the caller passed it in `tools`. Unattended callers (board effector) pass `null`. |
| `askTimeoutMs` | Watchdog for an unanswered interactive question. Default `DEFAULT_ASK_TIMEOUT_MS` (60 min, same as Settings → Watchdog `chat.generationIdleTimeoutMs`). Ignored when `ask` is null (immediate tool error). Never `0` — a chat turn must not hang forever. Test hook: pass a small positive number. |
| `messages` | Prior transcript for a continuation (no leading system required). **P6-C.** Wins over `seedKind`. |
| `seedKind` | `'continue'` loads `transcript.load(chatId).messages` and appends `user(seed)` unless that user row is already last. Default / omitted is isolated `[system, user(seed)]` (board callers that pass only `seed`). **P6-C.** |
| `nudgeToolUse` | When `false`, skip the inner `SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION` user row. Default `true`. Chat passes `false`. **P6-C.** Announce-then-stop prose (`looksLikeIntentToAct`) still spends one hidden `INTENT_TO_ACT_RETRY_INSTRUCTION` retry with tools present, even when this flag is `false`. |
| `finalizeStructuredOutcome` | When `false`, skip `requestStructuredOutcome`. Default `true`. Chat and the board effector pass `false`. Sub-agents omit (stay on). **P6-C.** |
| `summarySchema` | Forwarded to the inner loop when finalization is on. Chat omits it. |

`ask_question` is callable when an `AskCapability` is injected, and unavailable
when it is not. The runner still has no `isBoard` / chat-vs-board branch.
A fabricated call with `ask: null` returns an `Error:` tool result immediately
and the turn continues.

## Phase 6 — P6-A chat spike (MIN-723)

P6-A did **not** change this signature. A flag-gated renderer adapter
(`src/chat/run-turn-chat.ts`) called `runTurn` for a simple interactive chat
and mapped `onEvent` onto the existing chat DOM. P6-C closed the interface
gaps that spike recorded (see the P6-C section below).

## Phase 6 — P6-B `AskCapability` (MIN-724)

P6-B **did** change this signature: `ask` / `askTimeoutMs` on `RunTurnOptions`.
That is the intended PRD §9 change ("`ask_question` treated as an injected
capability rather than a hardcoded absence").

The P6-A spike injects a handler backed by `enqueueAskQuestion`. It does **not**
put `ask_question` in `spikeChatToolDefinitions()` — the capability is what
adds the schema. Board `createRunnerEffector` passes `ask: null`. Human-gated
tools that are not this injection (`enqueueToolApproval`, destructive confirm)
are documented in
[`documentation/plans/orchestrator-v2-p6b-human-tools.md`](../../documentation/plans/orchestrator-v2-p6b-human-tools.md).

## Phase 6 — P6-C strangle (MIN-725)

P6-C **did** change this signature (findings 1, 2, 4 from the gap list):

- **History continuation.** `messages[]` or `seedKind: 'continue'` (loads the
  transcript store and appends `user(seed)` unless that user row is already
  last). Persist suffixes product rows and does not splice a second
  `[system, user]` into chat history. Board callers that pass only `seed` keep
  isolated start. Finding 3: chat maps `no_report` → turn complete (no new
  `TurnResult` outcome). Finding 5 falls out of suffix persist.
- **Optional report tool.** `injectReportTool: false` or `reportToolName: null`
  omits injection. Default remains inject-on. There is no product-shaped
  branch in this package.
- **Nudge + finalization gates.** `nudgeToolUse: false` and
  `finalizeStructuredOutcome: false` skip the inner sub-agent tool-use nudge
  and structured-outcome extra completion. Chat passes both `false`. Board
  callers pass `finalizeStructuredOutcome: false` so the inner loop nudges
  `report_outcome` instead of asking for sub-agent `summary`/`findings` JSON.
  Inner-loop retries (empty post-tool, prose `ask_question`, announce-then-stop
  intent-to-act) still run with `nudgeToolUse: false`; the intent-to-act path
  is capped at one hidden user row so a “Let me inspect…” stop does not finalize.

The chat adapter (`src/chat/run-turn-chat.ts`) is the product send path around
`runTurn()` (P6-D / MIN-726). Completions: HTTP `/api/generations` via
`postChatCompletions` (`persist: true` for main chat; first call of a boot
resume passes `resumeGenerationId` so it subscribes instead of POST). Tools:
existing `executeTool` / `runHeadlessToolBatch`. Super Plan, attachments/VLM,
exclusive skill compose, and `suppressUserEcho` are caller overlays. There is
no dual-path flag. Stream-end order is `setStreaming(false)` **before**
`notifyChatStreamEnded`. Board `runTurn` is unchanged (report tool, `ask: null`,
nudge/finalization defaults on).

Finding 6 (`execute` attachments) is closed in P10-B: `TurnEvent.tool_result`
now carries `attachments` / `codeChange` / `isError`. Finding 7 (lifecycle
events) is the rest of P10-B (`round_start` / `round_end` / `phase` /
`reasoning_end` / `stream_meta`).

## Completions — in-process binding (MIN-700 / P2-C)

Server callers inject `postChatCompletionsInProcess` from [`node.js`](./node.js)
(not the isomorphic `index.js` barrel). It creates a generation (`persist: false`),
calls `pumpUpstream` in-process, and
returns a synthetic `Response` whose body replays SSE bytes — the same shape
`sse-parse.js` already consumes. There is no hop through `/api/generations`.

Default fallback role is `sub-agent` (agent family, not `utility` /
`chat-titles` / `goal-eval` / `editor-completion`). The loop may pass a more
specific type (`turn`, `explore`, …); those stay as-is. Aborting the `signal`
calls `cancel(state)` so the upstream request stops.

The renderer wires HTTP `/api/generations` via
`src/agents/renderer-runner-deps.ts` (`src/providers/fetch-chat.ts`).
`postChatCompletionsHttp` remains for tests that POST a fake host without
the generations store.

## Tools — in-process dispatch (MIN-701 / P2-D)

Server callers inject `createInProcessToolDispatch({ cwd, allowedToolNames, modeId })`.
It closes over **required** `cwd` (never defaults to the Code workspace root),
applies the same HTTP-layer guards as POST `/api/tools`, then calls
`executeServerTool`. There is no hop through `/api/tools`.

`runTurn` already takes `execute` + `deps.runHeadlessToolBatch`. Wire both from
the same dispatch object:

```js
const dispatch = createInProcessToolDispatch({ cwd, allowedToolNames });
await runTurn({
  chatId, seed, tools, model, cwd,
  execute: dispatch.execute,
  deps: { ...deps, runHeadlessToolBatch: dispatch.runHeadlessToolBatch },
});
```

Batching is a port of `src/tools/execute-tool-batch.ts` (`MAX_PARALLEL_READ_TOOLS = 6`).
Do not invent new concurrency rules.

The renderer adapter must **not** import `tool-dispatch.js` or `node.js`
(it would pull `server/runtime/tools-middleware.js` into Vite). It keeps
`src/tools/headless-tool-batch.ts`. Vite follows unused named re-exports, so
in-process adapters are on [`node.js`](./node.js), not the isomorphic `index.js`.

Default unattended tool ids: `DEFAULT_HEADLESS_TOOL_IDS`. Renderer-only tools
are enumerated in [`tool-set.md`](./tool-set.md) (port vs exclude). The default
set contains none of them. The runner still does not know what a board is —
the list is an argument.

## Phase 8 — P8-D sub-agent effector (MIN-757)

**No `runTurn` signature change.** Sub-agents are the second consumer of the
existing options (`parseReport`, `systemPrompt`, `ask`, `seedKind: 'continue'`,
`summarySchema`). The mapping lives in
[`server/sub-agents/effector-runner.js`](../sub-agents/effector-runner.js).

**MIN-724 on a background surface:** the sub-agent effector passes `ask: null`,
the same as the board effector. `ask_question` is therefore absent from the
resolved list. Unattended/headless has no human to answer; a fabricated call
is an immediate tool error. A parent-injected `AskCapability` later is an
**options argument on the effector** (default `null`), not an `isSubAgent`
branch in this package. Do not add one.

## Phase 10 — P10-B TurnEvent contract (MIN-767)

`TurnEvent` is widened so a caller can rebuild per-round chrome from facts the
inner loop already computed and dropped. The runner still does not know what a
chat is. `phase` is the
inner loop's own word (`generating` | `thinking` | `tools`).

New members, in order within a model round:

```
round_start → (phase / thinking / delta / stream_meta)* → reasoning_end
  → tool_streaming → tool_call* → tool_result* → round_end
```

- `phase` — forwarded from `onLiveActivity.phase` (the wrapper used to discard it).
- `reasoning_end` — once per round, when the inner loop leaves the reasoning
  channel (first prose, first tool-call streaming, or end of stream).
- `stream_meta` — throttled (~80 ms) forward of merged `streamMeta` from
  `handleChunk` (`usage`, `stats`, llama.cpp `runtime`, `model`, `finishReason`).
- `round_start` / `round_end` — `round_end` carries `text`, `reasoning`,
  `toolCallCount`, `usage`, `stats`, `finishReason`, `t0` / `tFirst` / `tEnd`.
  It fires **after** the last `tool_result` of that round (including a
  report-tool throw that unwinds the loop). The stream-error partial path is
  not a round boundary.

`tool_result` now carries `attachments` / `codeChange` / `isError`, and always
fires: emit moved onto `onToolDone` so parseError and abort fills are not
silent. `execute` no longer emits.

High-frequency types (`stream_meta`, `phase`, `round_start`, `reasoning_end`,
plus `token` / `delta` / `reasoning_delta`) are classified by
`isHighFrequencyTurnEvent` in this package. **This is a runner contract any
`TurnEvent` sink must use** — not a board detail. Do not invent a second list.

- **Disk** (board `transcripts.js`) and **board live SSE** drop the whole set so
  a 12 Hz `stream_meta` cannot cap a P9-D log. `round_end` is **not**
  high-frequency; it is recorded.
- **Sub-agent live SSE** uses `shouldEmitSubAgentLiveTurnEvent` (P10-L) so
  `phase` reaches cards. `phase` is not 12 Hz; the generating fallback without
  it was a lie. Disk still drops `phase`. P8-F records **no** attempt
  transcript — the sub-agent effector forwards to `emitLive` only.

## Phase 10 — P10-C settled persist (MIN-768)

Continue-mode turns used to persist **once**, in `finally`, from the last
`onMessagesChange` snapshot. A crash, Stop, or chat-switch mid-turn lost every
completed tool round. Isolated (board) persist was already live and is
**unchanged**.

**Inner callback (backward compatible):** `onMessagesChange(messages, meta?)`
gains `meta: { settled: boolean }` (`MessagesChangeMeta`). Existing callers
that ignore the second argument stay valid.

- Forced emits (`emitProgress(undefined, true)` after a real `messages.push`)
  → `settled: true`.
- Throttled emits (`emitProgress(streamingAssistant)` during a stream, synthetic
  partial on the clone) → `settled: false`. Leading+trailing (~80 ms): a token
  burst that would otherwise keep the first snapshot schedules one trailing
  flush of the latest clone. A settled force emit cancels that timer so it
  cannot grow a second synthetic assistant row.

Live chat UI does **not** wait on that persist throttle. `onDelta` emits
`TurnEvent.delta` via a microtask (latest snapshot wins) and flushes
immediately on `tool_streaming` / stream end, so the bubble is not stuck on
the first word until the generation finishes.

**Continue persist:** a monotonic `persistCursor` starting at
`buildOpeningTranscript().persistFrom`. On `settled === true`, suffix
`persistNewMessages(..., { from: persistCursor })` then
`persistCursor = messages.length`. `finally` keeps the same persist as an
idempotent backstop for abort/throw — the cursor makes it a no-op when nothing
new landed. Unsettled clones are never appended (no synthetic partial assistant
row). Stopped/failed presentation of a partial is a chat-caller overlay
(P10-E / `src/chat/settle-interrupted-turn.ts`), not a runner persist of that clone.

**Sub-agent retries** are continue turns (P8-D passes `messages` +
`seedKind: 'continue'`). They still use `createMemoryTranscriptStore()`, so
incremental persist is a no-op there. Do not change that.

**Seed equality:** `buildOpeningTranscript` still skips a trailing user row
whose string content equals `seed`. `persistFrom` points past the whole prior
transcript when it does append a new user row. Chat passes `seed: historyContent`
(not `userText`) so a skill-tagged send does not mint a second user row (P10-D).

## Phase 10 — P10-I in-turn steer (`onRoundBoundary`) (MIN-774)

P6-C reduced mid-turn steer to abort + follow-up. That killed the live turn,
marked the run failed, and split one turn into two. P10-I restores the
loop.ts behaviour with an injected hook — same shape as `AskCapability`,
not an `isChat` branch:

```ts
onRoundBoundary?: () => TranscriptMessage[] | null
```

The inner loop consults it at the top of every tool-loop iteration (after
tools, before the next completion). Returned rows are spliced into the
in-memory transcript. Chat implements this with `consumePendingSteer` +
`syncComposerMessageQueue` (`createChatRoundBoundary`). Board and sub-agent
callers **omit** the hook.

Continue persist: chat already wrote the product row in `consumePendingSteer`
(including `steer: true` for the reload chip). The wrapper advances
`persistCursor` by the spliced length so suffix persist does not duplicate
it. Isolated persist still keys off store length.

A throwing hook is swallowed (caller seam). There is still no `isBoard`
branch. Do not abort the live generation when a steer is enqueued.

