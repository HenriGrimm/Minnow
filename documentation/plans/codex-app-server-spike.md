# Codex app-server protocol evidence

Tested September 30, 2026 on Windows with installed Codex CLI **0.153.4**. This records the initial protocol spike. The generation migration implemented October 1 supersedes the initial limitations below; see [implementation and validation](codex-app-server-migration-status.md). No subscription inference or host credentials were used.

## Reproduce

```powershell
node scripts/codex-app-server-smoke.mjs
node scripts/codex-app-server-smoke.mjs --compaction
$env:MINNOW_CODEX_APP_SERVER_SMOKE = '1'
node --test test/generations/agent-cli-codex-app-server-smoke.test.mjs
```

The script resolves the installed binary without a shell, starts it with a fresh scratch home and working directory, and selects a custom provider backed by an ephemeral loopback Responses endpoint. Its environment excludes API keys and the original home. The child exits before its scratch home is deleted. The installed-CLI suites are opt-in; ordinary CI runs deterministic transport fixtures and skips these two checks. A missing installed CLI is an explicit error when the smoke is requested.

## Observed behavior

| Check | Result on 0.153.4 |
| --- | --- |
| Incremental text | Separate `First ` and `reply.` deltas arrive before completion. |
| Warm turns | Ten follow-ups use the original process/thread. `turn/start` submits only new input; previous answers appear in the native model history. |
| Typed seeding | `thread/inject_items` accepts user/assistant messages and paired `function_call` / `function_call_output`; the first inference receives the recorded tool result. No inference starts during injection. |
| Native tool isolation | The normal inference wire contains only `minnow_lookup`. Feature flags alone leave native `request_user_input` enabled; `[tools] experimental_request_user_input = { enabled = false }` suppresses it. A scripted undeclared `shell_command` receives `unsupported call: shell_command`, without a client tool request. Compaction requests have no tools. |
| Dynamic tool handoff | Both native calls have distinct RPC IDs and call IDs and refer to the same thread/turn. The client supplies real results and the same native turn continues. |
| Parallel response | Two calls in one upstream response are delivered **serially**: after 250 ms only the first request is pending; the second arrives after the first result. Waiting for both before replying deadlocks. |
| Structured output | `turn/start.outputSchema` reaches the Responses wire as a strict JSON schema. This checks transport, not real-model schema compliance. |
| Usage | Fifteen model requests on the retained thread total 375 tokens, including 60 cached input and 15 reasoning output tokens. `tokenUsage.total` is cumulative; `last` describes one request. These are scripted counts, not tokenizer estimates. |
| Required tools | An explicit required-tool instruction still sends `tool_choice: auto`. A scripted answer without the tool completes natively. Minnow must validate this itself; instructions do not enforce wire tool choice. |
| Interruption | Responsive local fake endpoint acknowledges interruption and emits an interrupted turn in roughly 15 ms in the measured run. This is native protocol latency, not a Minnow Stop benchmark. |
| Native compaction | Setting the documented `model_auto_compact_token_limit = 1` causes two compactions and four model requests for two user turns. The subsequent inference no longer contains the recorded historical tool result. |

The main smoke uses one additional ephemeral thread in the same process for required-tool and native-tool rejection checks; its usage is excluded from the retained thread's fifteen-request totals. The interruption check starts one further incomplete request. These checks are excluded from the completed-request usage baseline.

## Release gate still open

Native compaction demonstrably changes accepted context without a Minnow context-policy decision. The implemented adapter rejects compaction at item start, disposes the connection, and sends an overflow through Minnow's context-policy retry path. Runner integration tests verify that Minnow reduces its recorded history before reconstruction. Native observed context usage is separate from allocated billable usage.

CLI **0.153.4** is the supported minimum established by local Windows runtime checks. The implementation adds generation, runner recovery, retention, cleanup, reconnect, and forwarding tests. CI runs the installed-CLI fixtures on Windows, macOS, and Linux; local Windows results do not substitute for those other operating systems.

## Shared transport

`server/generations/codex-app-server/rpc.js` owns bidirectional stdio, numeric client request correlation, server request IDs, and process-tree cleanup. It keeps stdin open after initialization. It bounds record size, outstanding requests, aggregate pending server-request bytes, and queued writes. Startup text is ignored; split UTF-8 is decoded using the existing JSONL decoder. Unknown native requests receive an unsupported-method error and no authority. Diagnostics omit native stderr and response error text because those can contain credentials.

Model discovery now uses this client for initialization and paginated `model/list`, retaining the existing private auth home, cache, and total discovery deadline. Discovery still starts no thread or inference. Repeated pagination cursors fail explicitly.

Deterministic tests cover out-of-order replies, byte-split Unicode, pending request deduplication, conflicting IDs, concurrent reply rejection, unknown requests, backpressure, aggregate byte/count limits, deadlines, cancellation, process exit, explicit shutdown, and failed spawn. Transport-level cancellation removes a caller; it is **not** a native-turn interrupt implementation.

Official references: [app-server protocol](https://learn.chatgpt.com/docs/app-server) and [documented compaction threshold](https://learn.chatgpt.com/docs/config-file/config-reference). Schema availability was checked locally; the results above come from runtime checks.

## Verification for this change

- `npm run test:agent-cli`: passed, including the existing Claude and Cursor checks. Installed-CLI smoke checks are run separately with their opt-in.
- Both installed-CLI smoke scenarios: passed on Windows 0.153.4.
- `npm run test:engine` and selected runner compaction, context-overflow recovery, generation binding, and generation fallback tests: passed.
- `npm run test:check-coverage`, `npx tsc --noEmit`, and production build: passed.
- `npm run check:performance-budgets`: **failed**. Total assets were 10,727.1 KB against a 10,600 KB ceiling, a 127.1 KB breach. This change includes no frontend source or asset edits; no budget or baseline was raised.
- `git diff --check`: passed. Build-generated settings/wiki drift was removed from this change.

Desktop visual behavior and macOS/Linux execution were not checked. No new generation adapter is connected to the UI.
