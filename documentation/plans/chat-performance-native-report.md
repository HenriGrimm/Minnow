# Native CLI capability and checkpoint report

Historical capability report. The trusted host and default-off experiment are now integrated for the explicitly supported Windows candidate; see [production validation](chat-performance-production-validation.md). The blocked statements below describe the earlier stage, not the current integrated build.

Date: 2026-11-07. Scope: enforceable portions of steps 10–13 in `chat-performance-server-execution.md`.

**Installed-effect follow-up:** [Windows native enforcement evidence](chat-performance-native-enforcement-evidence.md) supersedes this initial report's **not exercised** statements for the tested Windows/MXC cases. Real native read/edit/test, Plan/path/junction/network denies, private-home read exposure and approval escalation/cancellation were exercised against CLI 0.166.0 with loopback fake inference. Unsupported native histories now quarantine rather than resume/rebuild. This establishes candidate OS primitives, not production native admission: steps 10–12 still need the trusted host contract described in the follow-up.

## Delivery status

- **Step 10: protocol inspected; native-on enforcement gate BLOCKED.** Installed `codex-cli 0.166.0`, Windows x64, Node 24.19.0. Generated matching experimental app-server JSON schemas in an isolated scratch home. No native-on configuration is supported or inferred from the installed version.
- **Step 11: native action admission/recovery BLOCKED.** Existing dynamic-tool isolation remains in place. A requested native opt-in fails before launch/reuse and cannot silently fail over to another tool mode. No observational event is converted into an executable Minnow call. No native actions were enabled or claimed durable.
- **Step 12: safe unavailable state delivered, NOT an experiment switch.** CLI status returns `nativeCodingTools: false` plus `{ available: false, effective: 'minnow', reason }`. Models → CLIs displays the Codex reason as ordinary wrapping hint text, without a switch. Omission is off; the provider settings endpoint accepts an explicit Codex `false`, rejects non-booleans and rejects enabling/non-Codex use before creating a provider. No paid A/B comparison was run.
- **Step 13: targeted checkpoint improvement delivered.** Concurrent Codex checkpoint requests share one in-flight verification. Later requests still re-read and hash the complete history. RPC reads have a two-second timeout (not a total filesystem-finalization deadline). Dirty epochs invalidate late verification; clean is set only after the checkpoint write succeeds. Resume fingerprints, canonical-prefix checks, rollout digests and credential identity are unchanged.

## Protocol and permission feasibility matrix

Official reference: [OpenAI Codex app-server documentation](https://developers.openai.com/codex/app-server), fetched during this task. The installed generated schemas, not the current website, establish the installed protocol shape. Schema presence is **not** evidence of OS enforcement or action safety.

| Capability | Installed 0.166.0 protocol evidence | Effective Minnow behavior / missing proof |
| --- | --- | --- |
| Native read/search | Sandboxes include `read-only`, `workspace-write`, `danger-full-access` | Disabled. No verified mapping from native reads/searches to current Minnow per-tool/path ceilings; read-only does not establish workspace-only reads. |
| Native commands | Command approvals identify thread/turn/item and offer policy decisions; command/action descriptions can be best-effort | Disabled. Native shell can write files; no verified before-effect intersection with tool Ask/Off, shell and filesystem grants. |
| Native file changes | File-change approvals identify thread/turn/item; `grantRoot` is documented as unstable | Disabled. No trusted approval bridge, revocation recheck or proven path-boundary enforcement. |
| Network/filesystem sandbox | Turn policies include `readOnly` with network off by default, and `workspaceWrite` with writable roots/network controls | Native-on unavailable on **all** platforms/versions. Actual Windows deny-before-effects, out-of-root/junction protection and network isolation were not exercised or certified. No sandbox setup or user settings were changed. |
| Approvals | Installed approval values are `untrusted`, `on-request`, `never`, plus a granular object | Existing adapter rejects native permission requests; protocol notifications alone cannot authorize actions. Durable execution/request identities, bounded arguments, revocation and baseline barriers remain prerequisites. |
| Native events/recovery | Thread/turn/item lifecycle, full reads and paged history exist | Native command/edit events are unsupported, not fake Minnow tool calls. Native effects have no reviewed durable intent/result/uncertainty recovery path, so native-on stays off. |
| Private credentials/config | Existing manager creates a private home and disables hooks, plugins, native subagents/browser/image generation and other features | Retained. Installed-CLI loopback test uses a fake provider, scratch home and no user credentials. Native-on credential exposure has not been certified. |
| Plan, utility and restricted child profiles | No verified automatic mapping of Minnow mode/tool/child/account ceilings to native policies | No native mode is admitted, including Plan and tool-choice-none utility requests. Guard runs before fallback eligibility; rejected opt-ins cannot become an unlabelled dynamic-tool comparison. |
| Resume/pagination | `thread/read.includeTurns` exists; installed schema describes paginated full-history hydration as deprecated. `thread/turns/list` has cursor/itemsView | Existing supported dynamic histories resume after full digest and canonical-prefix verification. Pagination was not substituted for those digests without an equivalence proof. Native-on histories are not created or resumed. |
| Unknown versions/methods | Generated-schema smoke is explicitly pinned to 0.166.0 and fails review on a different version | Native-on remains unavailable regardless of version/platform/mode. Existing dynamic-only minimum-version behavior is unchanged. Unsupported native items/requests remain rejected. |

### Reviewed schema SHA-256 values

Generated with `codex app-server generate-json-schema --experimental --out <scratch>/schemas` and independently regenerated by `agent-cli-native-capabilities.test.mjs`:

| File | SHA-256 |
| --- | --- |
| `v2/ThreadStartParams.json` | `80a40a7fac15b4bf70efb7f893fb353acc0a0d30c68f54aee4f01923deca85de` |
| `v2/TurnStartParams.json` | `c7483aee79757d260c4fc1bb5c68b1a8d6f72846388e9f1e88d6f76f423287c8` |
| `v2/ThreadReadParams.json` | `dfe040c6ac71d30795b8be3f3ff232e66f362a37f883b491e5d1ea367f470db4` |
| `v2/ThreadTurnsListParams.json` | `2a8b93d7d4437cc25e16a1dde16d8db3c338d39e16c5eece2a56e943a21577d7` |
| `CommandExecutionRequestApprovalParams.json` | `c9728280b8f3204fd729d0fb3d1ca7bb05b1150de26b3653f7163e6a9bd941e7` |
| `FileChangeRequestApprovalParams.json` | `13848b26814c286ad6425a20d01c1691c86790e1f9e2529399677a8a22fe0d18` |

## Settings lifecycle correction

Previously, settings routes disposed every matching session **and forgot its cache before validating or saving**. Invalid JSON/settings or a failed write could therefore stop work and delete compatible checkpoint homes. The route now parses, validates and saves first, invalidates catalog discovery only after success, then closes only genuinely idle sessions. The shared chat lock excludes the interval where retention marks a session idle but its generation is still settling. Active and awaiting-tool sessions retain their homes; no bulk checkpoint-forget call runs on settings edits. Subsequent reuse still requires existing fingerprints to match.

Tests demonstrate invalid edits and an injected atomic profile-save failure cause zero disposal; success closes only the matching idle session, not running, awaiting-tool, locked-settling or other-provider sessions. Explicit provider-disable behavior remains a separate existing revocation path; its boolean validation/save now precedes disposal too. Settings storage is not a new transactional multi-file store: a later secrets-write error can still follow a successful profile write, but does not dispose sessions.

## Checkpoint and timing evidence

- Deterministic synthetic history: **10,000 turns / 3,087,578 bytes**. Four simultaneous checkpoint requests issue **one** full thread read and save the complete digest. A subsequent changed history causes another read and a new matching digest. No stat-only digest cache is introduced.
- One Windows fixture run measured the later synthetic read at 32.5663 ms (including an artificial 20 ms RPC delay), full history/accepted hash at 6.0413 ms and atomic checkpoint write at 2.4283 ms. These are fixture component measurements under concurrent tests, not production or end-to-end latency claims.
- Real installed Codex with loopback fake Responses inference: 10 warm follow-ups reused one process and retained exactly-once usage/results. In the final recorded run, checkpoint totals ranged **4.369–7.7531 ms**, full thread reads **2.14–5.53 ms**, rollout digests **0.5105–1.6675 ms**, history hashes **0.0282–0.0652 ms**, and checkpoint writes **1.2483–1.8094 ms**. Component ranges come from different samples and must not be summed. Forwarding maximum was 0.0401 ms in this fixture, not received-to-painted latency.
- Payload-free Codex `minnow_cli.timings` reports `checkpoint_ms`, `checkpoint_thread_read_ms`, `checkpoint_rollout_digest_ms`, `checkpoint_history_hash_ms`, `checkpoint_write_ms`. Claude reports `claude_snapshot_ms` separately at handoff/final verification; its existing two-second native-transcript polling and prefix validation remain unchanged.
- No finalization work needed for restart safety was moved behind durable acknowledgement. Native full-history reads/digests and required snapshot waits remain unavoidable here. No claim of lower ordinary single-checkpoint work, constant-time long histories or a complete total-finalization deadline is made.

The first installed-CLI fixture attempt failed an older assertion expecting serial dynamic calls (`2 !== 1`). Codex 0.166.0 delivered both calls together. The fixture now permits either native grouping while requiring exactly two distinct calls, real result delivery, correct aggregate usage, one warm process and verified disk resume. It passes. This updates a version-specific transport expectation, not Minnow's permission or exactly-once assertions.

## Verification commands and results

All command tests used `node --test --test-force-exit`; UI/client tests additionally used `--import tsx --import ./test/test-loader.mjs`.

- API/checkpoints/pump/native-capabilities/persistence/concurrency/upstream: **145 passed, 1 opt-in schema test skipped**, zero failures. Files: `test/models/agent-cli-api.test.mjs`; `test/generations/agent-cli-{checkpoints,codex-app-server-pump,native-capabilities,persistence,concurrency,upstream}.test.mjs`.
- Protocol/conversation/translation/auth/invocation/catalog/login regression group: **110 passed, 3 opt-in installed-CLI tests skipped**, zero failures. Files: `test/generations/agent-cli-{codex-app-server-conversation,codex-app-server-rpc,codex-app-server-translate,codex-app-server-smoke,codex-auth,codex-model-tools,invocation,protocol}.test.mjs`, `test/providers/agent-cli-catalog.test.mjs`, `test/models/agent-cli-{codex-catalog,login}.test.mjs`.
- Models CLI UI and client: **27 passed**, zero failures: `test/ui/models-cli-panel.test.mts`, `test/models/agent-clis-client.test.mts`. Includes honest Codex reason/no switch, autosave/error-draft behavior and other existing controls. Design context/aesthetics were loaded. Desktop/narrow fixture inspection is recorded below; native keyboard keystroke automation remains blocked.
- Explicit installed checks: `set MINNOW_CODEX_SCHEMA_SMOKE=1&& set MINNOW_CODEX_APP_SERVER_SMOKE=1&& node --test --test-force-exit test/generations/agent-cli-native-capabilities.test.mjs test/generations/agent-cli-codex-app-server-live.test.mjs`: **4 passed**, zero skipped/failures. All inference goes to loopback fixtures; generated schemas and CLI homes are scratch-only.
- `npx tsc --noEmit`: passed. Affected TypeScript model/status/UI files had no LSP diagnostics.

These are overlapping focused runs, not a summed unique-test count or a full repository/packaged-app certification. No paid runs, live settings edits, commits, sandbox setup or unrestricted native commands were used. Native-on before-effect enforcement, Windows/macOS/Linux packaged tests, durable native approval/recovery integration and paid A/B comparison remain unverified gates. The parent task owns broader execution-host/checkpoint coordination and overall rollout verification.

## Rendered CLI caption verification (follow-up)

Rendered `test/fixtures/agent-cli-preview.html` in private agent-browser tabs using a dedicated **Vite-only** server on loopback, without a tool server or live provider settings. The fixture imports the actual pure `agentCliNativeCodingCapability('codex')` helper, so the inspected reason is the shipped copy, not a shortened substitute. All provider/auth/settings dependencies remain mocks. Browser performance resource entries showed **zero `/api/` requests** at each inspected viewport; no settings were edited and no inference was requested.

| Viewport | Caption geometry | Observation |
| --- | --- | --- |
| Desktop 1440 × 1000 | 465.75 × 54 CSS px, 12 px type / 18 px line height; 3 lines | Complete reason visible, aligned with existing connection hints above the fields; no overlap/clipping. Document width 1440, no page overflow. |
| Narrow 390 × 844 | 318 × 72 CSS px, 12 px type / 18 px line height; 4 lines | Complete reason wraps above the existing binary-path hint. Fields stack normally; no overlap/clipping. Document width 390, no page overflow; existing section navigation scrolls within its own container. |

**Visual critique:** retained the existing restrained hint typography and separation from executable controls. Neither viewport suggests an available experiment or exposes a native-tools switch. The long caption remains secondary to connection controls while stating the enforcement/recovery limitation and the usable alternative. No corrective CSS change was needed.

**Accessibility evidence:** the Codex disclosure is native `SUMMARY` within `DETAILS`, reports `tabIndex=0`, and accepts programmatic focus. Pointer activation expands it, and the complete caption appears as paragraph/static text in the browser accessibility snapshot. The caption correctly adds no focusable pseudo-control. No native coding input exists.

**Exact remaining keyboard probe blocker:** `agent-browser --session native-cli-caption-qa open <loopback-fixture>` timed out after 30 seconds with `Invalid response: EOF while parsing a value at line 1 column 0 (after 5 retries - daemon may be busy or unresponsive)`. The available supplied browser tools have no keypress operation. Real Tab/Enter and keyboard focus-ring observation are therefore **unverified**, not passed. No WCAG certification or clean-console claim is made; no console-error subscription was active.

Evidence artifacts:
- [Desktop screenshot](chat-performance-native-desktop.png)
- [Narrow screenshot](chat-performance-native-narrow.png)
- [Structured viewport/accessibility observations](chat-performance-native-ui-evidence.json)

These screenshots show a mocked fixture, not a live profile. The native protocol/enforcement matrix above is unchanged: **step 10 acceptance is not met**, and native action admission/recovery plus an enabled experiment remain blocked.
