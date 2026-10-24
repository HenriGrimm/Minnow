# Extensions and assistant services review

Date: 2026-10-23. Baseline: `ba2068d1c5353f86287f9a02b665fb7ea0bbac3f`. Read-only review; no external integrations/accounts were configured.

## Scope and assessment

Sampled built-in/user skill scan/load and invocation metadata, shared prompt composition and injection gates, plugin package validation/install/update/revocation, native worker lifecycle and sandboxed panel bridge, MCP naming/config/connection/reload/OAuth/tool dispatch, voice dictation and streaming speech clients, notification capture/dedupe/navigation, and webhook signing/target validation/queue/delivery persistence. Main sources: `server/{skills,plugins,mcp,webhooks}/*`, `src/{plugins,voice,notifications}/*`, `src/ui/{composer-voice,voice-controls}.ts`, `server/voice/builtin-stt.js`, and `src/chat/prompts/{prompt-composer,compose-context}.ts`.

These services should let a builder speak, connect tools, receive the right interruption, and return to a useful conversation. Plugins have unusually thoughtful lifecycle and trust handling. The main risks are inconsistent identifiers/result semantics across integration boundaries, and async voice/notification work whose ownership is defined by UI state rather than a captured chat/attempt.

Not reviewed exhaustively: real third-party OAuth providers, full MCP resource/prompt catalogs, downloaded skill packs, remote plugin archives, actual microphone/audio devices, Python/GPU inference, push notification delivery across OSes, all webhook retry outcomes, all prompt fragments/mode matrices, and mobile real-device behavior. No external downloads or live account actions occurred. The MCP OAuth check used a local mock server.

## Good

1. **Plugin trust is explicit.** Inspection tells users native handlers have full local access and UI modules access the host DOM/APIs (`server/plugins/manager.js:59`). Workers are disposable cancellation/resource boundaries, not misrepresented as an OS security sandbox. Preserve that distinction in onboarding and documentation.
2. **Package changes are reviewable and pinned.** Source digests can be checked at install/update (`server/plugins/manager.js:64`), releases are immutable UUID directories, mutations serialize, a bad update leaves the old release usable, and disabling/updating terminates handlers (`:119`). Connection settings are encrypted and secret fields are redacted (`:177`). Package tests exercised these paths and passed.
3. **Plugin panels use a narrow bridge.** `src/plugins/panel.ts:14` uses an opaque sandboxed iframe, restrictive CSP, sender/channel validation, declared-tool checks, bounded concurrent requests and release pinning. Disposal aborts requests and removes listeners. The adversarial panel test passed. Host-native UI modules are a separate trusted capability, not covered by the iframe guarantee.
4. **Native plugin work can be stopped.** `server/plugins/runtime.js:9` limits concurrent workers, applies deadlines, handles abort, and terminates workers before settling. Tests cover synchronous hangs, caller cancellation, disable/reload and credential revocation.
5. **Skills have source-aware, read-only discovery.** `server/skills/scan.js:129` merges user overrides with built-ins; load-skill checks enabled/model-invocable state on every call and returns continuation/reference windows without executing scripts. Existing tests verified traversal/junction/non-text rejection and packaged reference access.
6. **MCP lifecycle handles more than a one-shot connection.** `server/mcp/registry.js:145` coalesces connections, fingerprints config and closes old clients; tool discovery follows pagination with repeated-cursor protection (`:38`). OAuth uses loopback state/PKCE, encrypted tokens and serialized credential persistence (`server/mcp/oauth.js:10`). Local mock OAuth/pagination/disabled-dispatch checks passed.
7. **Notifications separate history from interruptions.** Activity records remain when muted or a category is disabled; preferences gate delivery/sound (`src/notifications/push.ts:55`). Quota notices deduplicate known noisy failures, and navigation uses the owning chat (`src/notifications/navigate.ts:43`). Tests passed for muted capture and provider-quota notices.
8. **Voice has a practical low-setup path.** Built-in STT uses a bounded worker queue and WAV validation (`server/voice/builtin-stt.js:28`), while default speech output can use system/browser capabilities. First-use model progress stays on the initiating mic (`src/ui/composer-voice.ts:284`). No claim is made about actual transcription quality or platform device compatibility from source/tests alone.
9. **Webhook delivery is intentionally bounded and guarded.** `server/webhooks/ssrf.js:205` validates targets, rejects private addresses, and pins DNS results for the actual request. Signing binds timestamp/body (`server/webhooks/sign.js`); queue capacity includes delayed retries (`server/webhooks/emit.js:260`). The implementation explicitly says pending jobs are memory-only and not replayed after restart, an honest best-effort contract.
10. **Prompt composition has deterministic ordering and gates.** `src/chat/prompts/prompt-composer.ts:22` defines the part order; tool guidance checks actual tool availability, and empty memory can still receive save guidance. The sampled browser allowlist and memory-save fragment tests passed.

## Verified defects

### E1 — P2: Valid MCP server identifiers cannot round-trip through dispatch

- **Evidence:** `server/mcp/validate.js:5` permits arbitrary underscores in a server ID. `toNamespacedName` joins ID/tool with `__`, but `parseNamespacedName` splits on `__` and takes only the first component as server ID (`server/mcp/bridge.js:24`). `callMcpTool` uses that parsed ID for the enabled-server lookup (`server/mcp/registry.js:397`).
- **Trigger:** Import/register a valid server named `team__docs`, then use its `lookup` tool.
- **Observed:** Validation accepts `team__docs`; emitted name `mcp__team__docs__lookup` parses as server `team`, tool `docs__lookup`. The real dispatch lookup therefore cannot select the configured server from that name. Pure reproduction preserved in `evidence/services-identity-and-tts.mts`.
- **Impact:** A successfully configured integration exposes tools that fail as disabled/removed or route ambiguously if a matching shorter ID exists. No remote integration was invoked in this reproduction.
- **Confidence:** High, pure helper reproduction plus dispatch tracing.
- **Repair:** Use a reversible namespace or resolve whole emitted IDs through the registered map before parsing. Until migration is supported, reject ambiguous IDs at configuration import with a clear explanation. Preserve existing valid single-underscore/hyphen IDs.

### E2 — P2: Distinct MCP tool names emit the same model function name

- **Evidence:** `server/mcp/bridge.js:15` folds hyphens into underscores. `toOpenAIDefinitions` emits every resulting definition (`:42`), while `rememberTools` deliberately keeps the first name for a collision (`server/mcp/registry.js:119`). `listEnabledMcpTools` appends those definitions unchanged (`:363`).
- **Trigger:** A server advertises both `find-record` and `find_record`.
- **Observed:** The pure definition builder emits two identical function names, `mcp__docs__find_record`. The dispatch map selects only the first original spelling. The preserved reproduction verifies the collision.
- **Impact:** One operation becomes unreachable/ambiguous; some providers may reject duplicate function definitions, but provider-wide rejection was not tested and is not claimed as observed.
- **Confidence:** High for the duplicate IDs/unreachable second operation.
- **Repair:** Allocate reversible distinct names, retain original names in an exact dispatch map, and reject duplicate emitted IDs before supplying a model catalog. Show a concrete integration error instead of silently picking the first tool.

### E3 — P3: Cancelling speech before ready leaves the start promise unresolved

- **Evidence:** `src/voice/tts-stream-client.ts:78` resolves `start()` only on ready or rejects on errors. Cancel/close sets `closed=true`, then `onclose` deliberately neither resolves nor rejects in that state (`:128`, `:142`). No cancellation settlement function is stored.
- **Trigger:** Start local streaming speech and cancel before the server sends ready.
- **Observed:** A fake WebSocket with immediate close produced `cancelledTtsStartSettled:false`. No real audio was synthesized. Reproduction is preserved in `services-identity-and-tts.mts`.
- **Impact:** Direct callers can wait forever and retain pending continuations. The production read-aloud controller has a separate `cancelCurrentStream` resolver (`src/ui/voice-controls.ts:173`), which mitigates visible UI hangs for that path; this is why this finding is P3 rather than a claimed broadly broken read-aloud feature.
- **Confidence:** High for the client contract defect; broader impact is bounded by caller behavior.
- **Repair:** Settle pending starts on cancellation with an AbortError or explicit cancelled result, detach obsolete socket callbacks, and test cancel-before-open, cancel-before-ready, replacement and late old-socket events.

## Source-grounded risks and product improvements

### R1 — Preserve MCP result meaning, including failures and non-text content

`server/mcp/registry.js:423` keeps only text blocks and returns `OK` when none exist; it does not carry `isError` or structured/resource/image content. A screenshot/resource-returning MCP tool can therefore lose the useful result at this adapter. This is observed source behavior, not a claim about an integration used by this user. Define supported result kinds explicitly and preserve error metadata; attach supported media/resources as inspectable artifacts, and explain unsupported kinds instead of reporting a bare success.

### R2 — Pin dictation to a chat/draft identity, not just a textarea node

`src/ui/composer-voice.ts:37` pins a DOM input at recording start. Batch transcription later inserts into that input (`:296`), and streaming callbacks update it through `DictationRange` (`:380`). The shared Code composer can be reused when chats change; no chat ID/draft epoch is captured in this module, and the inspected sidebar paths do not stop or rehome dictation. This is a source-observed navigation risk, not a live microphone reproduction. Capture owning chat/draft at start, preserve its text on navigation, provide explicit stop/cancel, and ignore stale transcription results. A related test should cover changing chats while transcription is pending.

### R3 — Webhook deletion/disable does not necessarily revoke already queued attempts

Pending jobs capture destination and secret (`server/webhooks/emit.js:300`), and retry delivery uses that snapshot rather than rereading subscription state. Decide whether disable/remove means “future events only” or also cancels queued retries; make that behavior visible. DNS resolution is guarded but has no explicit timeout in the sampled target resolver, while the HTTP timeout starts after resolution. A stalled resolver can occupy the single delivery worker longer than the nominal delivery timeout. Neither case was reproduced here.

### R4 — Make plugin trust levels visible at the exact install decision

Native worker handlers, opaque panels and host DOM UI modules have materially different authority. Inspection text describes this correctly, but users should see the installed package's actual capabilities alongside its source/digest before installation. Do not imply that cancellation/resource caps restrict native filesystem or network authority. No exploit is asserted: these are explicitly trusted local extensions.

### R5 — Integration discovery should not make a slow connector stall all tools

`collectEnabledServerTools` iterates enabled MCP servers sequentially and waits for connect/list on each (`server/mcp/registry.js:338`). SDK transport deadlines may bound individual calls, but the aggregate catalog path needs a total budget, cached usable tools and per-server status. No latency regression was measured. Keep failed integrations discoverable in settings with a repair action, while known healthy tools remain usable.

### D1 — Use a single conversational integration receipt

After a connector/skill/plugin is added, show what is available, what it may access, where it is configured, and a safe test action. After failure, retain the request and offer Retry/Configure/Ask chat. Users should not need to understand MCP vs plugin vs skill to know whether a task can be completed, although advanced details should remain available.

### D2 — Notify for an actionable state change

Preserve the existing activity-vs-alert distinction. Group repeated attempts under the same task, show the required next action, and bring the user to the precise conversation/approval/result. Unify acknowledgement across multiple views before relying on notifications for unattended work. Actual multi-window duplicate/ack behavior was not exercised in this section.

### D3 — Treat dictation, read-aloud and future voice chat as distinct workflows

The current composer module is dictation; `src/voice/voice-session.ts:1` explicitly labels the voice-chat coordinator a future stub. Product copy should describe what ships and avoid promising a duplex conversational assistant. Make “recording,” “preparing,” “transcribing,” “playing” and “cancelled” observable with keyboard-accessible controls and durable draft recovery.

## Checks actually run

- `node --experimental-test-module-mocks --test --test-timeout=45000 test/mcp/bridge.test.mjs test/mcp/standard-config.test.mjs test/plugins/packages.test.mjs test/webhooks/sign.test.mjs test/voice/builtin-audio.test.mjs test/skills/load-skill.test.mjs` — **31 passed**. The OAuth server is a local fixture; plugin handlers are synthetic worker code. No external accounts/downloads were used.
- `node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs --test --test-force-exit --test-timeout=45000 test/plugins/panel.test.mts test/voice/tts-stream-client.test.mts test/voice/dictation-range.test.mts test/notifications/push.test.mjs test/notifications/provider-quota.test.mjs test/prompts/browser-allowlist-gate.test.mjs test/prompts/memory-save-fragment.test.mjs` — **24 passed**.
- MCP ID/collision and TTS cancellation reproductions passed as stdin commands. Preserved combined command: `node --import tsx documentation/reviews/2026-10-23/evidence/services-identity-and-tts.mts`. Its assertions intentionally demonstrate the current undesirable behavior. No server/model/audio hardware needed.

No full suite, provider interoperability matrix, external webhook sends, skill installs from the internet, or broad accessibility/device test was run here. Existing tests passing does not cover the demonstrated namespace/cancellation edge cases.

## Cross-vertical dependencies

Shared runner policy must preserve plugin/MCP permission and cancellation semantics in foreground, headless and board contexts; those paths were sampled only at their interfaces here. Brain owns automatic skill/memory proposals and their provenance/concurrency risks (report 06). Shell/runtime reviewers own process environment exposure and shutdown. Notification links depend on durable chat/activity identity, and voice draft ownership depends on the same navigation/session contract implicated in report 02. Prompt composition deserves model-backed workflow evaluation, not only assertions that fragments concatenate correctly.
