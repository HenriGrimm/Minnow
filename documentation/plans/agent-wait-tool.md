---
name: agent-wait-tool
overview: Add a built-in `wait` tool so an agent can set a timer with a duration and reason, get an in-app notification when it fires, and continue the same turn automatically with a tool result saying the timer completed — replacing spin-polling and give-up behavior.
todos:
  - id: W1-A
    content: "Wave 1: Add the wait tool to the built-in catalog, tool-id list, and mode matrix"
    status: pending
  - id: W1-B
    content: "Wave 1: Add the agent_wait notification kind, Timer sound cue, and preview label"
    status: pending
  - id: W2-A
    content: "Wave 2: Implement the wait timer module (clamp, abort, notify)"
    status: pending
  - id: W2-B
    content: "Wave 2: Add the waiting phase to main-turn activity and the agent activity panel"
    status: pending
  - id: W2-C
    content: "Wave 2: Add the Timer cue asset and sound-pack mapping test"
    status: pending
  - id: W3-A
    content: "Wave 3: Dispatch the wait tool in the client executor"
    status: pending
  - id: W3-B
    content: "Wave 3: Document the wait tool in the shipped manual and context.md"
    status: pending
isProject: true
---

# Agent Wait Tool

**Date:** 2026-09-19
**Goal:** Give agents a `wait` tool that parks a turn on a timer, notifies the user in-app when it fires, and resumes the same turn with a tool result saying the timer completed.

**Granularity:** medium

## Context

Agents that need to let time pass — waiting for a dev server to boot, a CI run to finish, a rate limit to clear — have no way to schedule that wait. They either spin-poll (`execute_command` with `sleep`, repeated `read_command_log` calls, repeated `git_status`) or give up and report failure. Both waste turns and tokens, and the second is a silent correctness problem: the agent reports "not ready" when it simply did not wait.

This plan adds one built-in tool, `wait`, with a `duration` and a `reason`. The tool call blocks until the timer fires, then returns a tool result the model reads as "the timer completed". The turn continues in the same loop — no new turn, no re-prompt. While the timer runs, the user gets a menubar bell notification (with the Timer sound cue) so they know the agent is parked rather than stuck.

**Decisions taken with the user (2026-09-19):**

| Question | Decision |
|---|---|
| Resume mechanism | **Blocking tool call.** The tool awaits the timer and returns a tool result; the loop continues in the same turn. |
| Maximum wait | **2 hours.** Fits under the 4 h `chat.generationMaxDurationMs` default; longer waits stay out of scope. |
| Surfaces | **Chat only.** Renderer tool. Headless sub-agents and board attempts keep their current behavior. |
| Stop mid-wait | **Abort.** Composer Stop aborts the wait and ends the turn, exactly like any other stopped tool. |
| Notification | **New `agent_wait` kind** in the Chat group, with a new `timer` sound cue. |
| Default enablement | **On by default** for new and existing installs. |
| Default permission | **`full`** — no approval prompt. The only side effect is a notification. |
| Activity panel | **Distinct waiting state** — "Waiting 5m — reason" with a frozen elapsed timer. |

### Why the blocking shape is safe here

The runner already has the exact mechanism this needs. `ask_question` is handled inside the tool loop at `server/runner/run-turn.js:595` — it awaits a capability and returns a tool result without the turn ending. `wait` uses the same shape: a client-side capability (`WaitCapability`, mirroring `AskCapability`) injected from `src/chat/run-turn-chat.ts:1613`, with the tool definition appended by a `withWaitTool(tools, wait)` helper mirroring `withAskQuestionTool` (`server/runner/ask-question-tool.js:84`).

The 2 h cap is the important guard. Chat turns pass no `limits.wallClockMs` (`chatTurnContextLimits` at `src/chat/run-turn-chat.ts:520` returns only context budget fields), so a blocking wait cannot hit a turn wall clock. It *can* hit the upstream generation watchdog, but that timer resets on every SSE chunk and only runs while a generation is streaming — a parked tool call is not streaming, so it is not at risk. The 2 h cap keeps the wait under the 4 h `chat.generationMaxDurationMs` default anyway.

### What already exists and is reused

- **Notification pipeline** — `pushNotification` (`src/notifications/push.ts:46`) handles prefs gating, dedupe, bell ring, sound, and optional OS toast. `pushNotificationOrActiveChatSound` (`:96`) is the chat-flavored variant.
- **Sound packs** — `src/notifications/sound-packs.ts` maps each kind to one of three cues. Adding a fourth cue is a small, contained change.
- **Activity state** — `src/chat/main-turn-activity.ts` already models a paused turn (`pauseMainTurnActivityForQuestion` / `resumeMainTurnActivityFromQuestion`, lines 75–100) with a frozen elapsed timer. The waiting phase copies that pattern.
- **Client tool dispatch** — `executeToolInner` (`src/tools/client.ts:235`) has a per-tool branch for `ask_question` at line 293; `wait` gets a sibling branch.
- **Tool catalog** — `server/tools/builtin-catalog.js` is the single source for `BUILT_IN_TOOLS`, re-exported by `src/tools/definitions.ts:47`.

### Out of scope

- Waits longer than 2 hours, or waits that survive an app restart.
- `wait` on headless sub-agents or board attempts (they stay on `server/runner/tool-set.js` lists, unchanged).
- Scheduling a wait that ends the turn and starts a fresh one later (the loop-ticker shape).
- Any change to the Scheduler app.

## Architecture / Key Files

| File | Role | Action |
|------|------|--------|
| `server/tools/builtin-catalog.js` | Single source of `BUILT_IN_TOOLS` (2299 lines) | MODIFY — add the `wait` entry |
| `server/config/tool-ids.js` | `ALL_TOOL_IDS` list consumed by config seeding, validators, profiles, evals | MODIFY — add `'wait'` |
| `src/chat/modes/tool-groups.ts` | `TOOL_GROUP_IDS` + `MODE_ALLOWED_GROUPS` matrix | MODIFY — add a `wait` group id and list it in every mode |
| `src/config/defaults.ts` | Client default `tools.json` seed (enabled + permission) | MODIFY — enable `wait` at `full` |
| `server/config/home.js` | Server default `tools.json` seed (`DEFAULT_ENABLED_TOOL_IDS`) | MODIFY — enable `wait` |
| `src/notifications/types.ts` | `NotificationKind` union | MODIFY — add `'agent_wait'` |
| `src/notifications/prefs.ts` | `KIND_GROUP` map | MODIFY — `agent_wait: 'chat'` |
| `src/notifications/sound-packs.ts` | `NotificationSoundCue` union + `NOTIFICATION_KIND_TO_CUE` | MODIFY — add `timer` cue and mapping |
| `src/notifications/preview.ts` | `kindLabel()` | MODIFY — `agent_wait` → `'Timer'` |
| `src/notifications/sound.ts` | `NOTIFICATION_SOUND_CUES` settings preview list | MODIFY — add the Timer row |
| `public/sounds/packs/default/timer.wav` | New cue asset | CREATE |
| `src/tools/wait-tool.ts` | Client timer module: clamp, abort, notify | CREATE |
| `src/tools/client.ts` | `executeToolInner` dispatch | MODIFY — `wait` branch |
| `src/chat/main-turn-activity.ts` | `MainTurnPhase` + pause/resume helpers | MODIFY — `waiting` phase |
| `src/state/agent-activity-registry.ts` | `AgentActivityStatus` + status line | MODIFY — `waiting` status |
| `src/chat/run-turn-chat.ts` | Chat turn wiring: capability injection, activity patches | MODIFY — inject `wait`, patch on tool events |
| `src/ui/agent-activity-panel.ts` | Activity panel rendering | MODIFY — waiting row styling |
| `documentation/manual/reference/tools.md` | Shipped tool reference | MODIFY — document `wait` |
| `documentation/context.md` | Authoritative technical reference | MODIFY — tool count + wait behavior |
| `test/tools/wait-tool.test.mts` | Timer module tests | CREATE |
| `test/tools/wait-tool-catalog.test.mts` | Catalog + mode matrix tests | CREATE |
| `test/notifications/agent-wait.test.mts` | Notification kind tests | CREATE |

## Wave Breakdown

### Wave 1 — Catalog and notification plumbing

#### Task W1-A: Add the wait tool to the built-in catalog, tool-id list, and mode matrix
- **Build:**
  - In `server/tools/builtin-catalog.js`, add a new entry to the `BUILT_IN_TOOLS` array, placed next to `get_datetime` (the other `utility` / `serverRequired: false` entry, currently at line 46). Use the existing `toolSchema(name, description, properties, required)` helper:
    - `id: 'wait'`, `label: 'Wait'`, `category: 'utility'`, `serverRequired: false`.
    - `description`: `'Pause this turn for a fixed duration, then continue automatically. Use instead of polling in a loop.'`
    - `definition`: `toolSchema('wait', '<same description text>', { duration: { type: 'string', description: 'How long to wait, e.g. "30s", "5m", "1h30m". Maximum 2h.' }, reason: { type: 'string', description: 'Short note shown to the user while the agent waits.' } }, ['duration', 'reason'])`.
  - In `server/config/tool-ids.js`, add `'wait'` to `ALL_TOOL_IDS` immediately after `'calculate'` (line 49).
  - In `src/chat/modes/tool-groups.ts`, add a new group to `TOOL_GROUP_IDS`: `wait: ['wait'],` placed directly after `'util-basic'`. Add `'wait'` to the `MODE_ALLOWED_GROUPS` arrays for **every** registered mode (`general`, `build`, `plan`, `super-plan`, `orchestrate`, `debug`, `onboarding`) — the tool is inert without a mode grant, and `test/modes/tool-policy.test.mts:271` fails if any built-in tool is missing from `TOOL_GROUP_IDS`.
  - In `src/config/defaults.ts`, add `'wait'` to `DEFAULT_ENABLED_TOOL_IDS` (line 24) and add `'wait'` to a new `WAIT_FULL_PERMISSION_TOOL_IDS` set consulted in `defaultPermissionForTool` (line 89) so it seeds `full` rather than `ask`.
  - In `server/config/home.js`, add `'wait'` to `DEFAULT_ENABLED_TOOL_IDS` (line 362) and add `if (id === 'wait') return enabled ? 'full' : 'off';` to `defaultPermissionForTool` (line 389).
- **Test:** `npx tsc --noEmit` (the catalog is typed against `ToolDefinition`), then `npm run test:modes` and `node --test --test-force-exit test/tools/config-bulk-permissions.test.mts test/tools/app-gated-tools.test.mts`. Assert `BUILT_IN_TOOLS.find(t => t.id === 'wait')` is defined, `ALL_TOOL_IDS.includes('wait')` is true, and `isToolAllowedForMode('plan', 'wait')` is true.
- **Accept:** `filterToolsByMode(BUILT_IN_TOOLS, 'build')` contains an entry with `id === 'wait'`, and a fresh `defaultToolConfig()` has `enabled.wait === true` and `permissions.default.wait === 'full'`.
- **Touches:** `server/tools/builtin-catalog.js`, `server/config/tool-ids.js`, `server/config/home.js`, `src/chat/modes/tool-groups.ts`, `src/config/defaults.ts`

#### Task W1-B: Add the agent_wait notification kind, Timer sound cue, and preview label
- **Build:**
  - `src/notifications/types.ts` — add `'agent_wait'` to the `NotificationKind` union (line 9), after `'chat_question'`.
  - `src/notifications/prefs.ts` — add `agent_wait: 'chat',` to the `KIND_GROUP` record (line 164). The record is `Record<NotificationKind, NotificationKindGroup>`, so a missing entry is a type error.
  - `src/notifications/sound-packs.ts` — add `'timer'` to the `NotificationSoundCue` union (line 9), add `timer: './sounds/packs/default/timer.wav',` to the `default` pack's `cues` (line 27), and add `agent_wait: 'timer',` to `NOTIFICATION_KIND_TO_CUE` (line 45).
  - `src/notifications/preview.ts` — add `case 'agent_wait': return 'Timer';` to `kindLabel()` (line 82).
  - `src/notifications/sound.ts` — add `{ id: 'timer', label: 'Timer' }` to `NOTIFICATION_SOUND_CUES` (line 18) so Settings → Notifications can preview the cue.
- **Test:** `npx tsc --noEmit` (three of the four edits are exhaustiveness-checked records/unions), then `node --test --test-force-exit test/notifications/prefs.test.mjs test/notifications/sound-packs.test.mjs`. Add assertions to `test/notifications/sound-packs.test.mjs`: `resolveNotificationSoundUrl('default', 'agent_wait')` equals `'./sounds/packs/default/timer.wav'`, and `resolveNotificationSoundUrl('none', 'agent_wait')` is `undefined`. Add to `test/notifications/prefs.test.mjs`: `isNotificationKindEnabled('agent_wait')` is `true` with defaults and `false` when `chatEnabled` is `false`.
- **Accept:** `pushNotification({ kind: 'agent_wait', title: 'Chat', preview: 'Waiting 5m — build', appId: 'code' })` returns a record whose `kind` is `'agent_wait'`, and `kindLabel('agent_wait')` returns `'Timer'`.
- **Touches:** `src/notifications/types.ts`, `src/notifications/prefs.ts`, `src/notifications/sound-packs.ts`, `src/notifications/preview.ts`, `src/notifications/sound.ts`, `test/notifications/prefs.test.mjs`, `test/notifications/sound-packs.test.mjs`

### Wave 2 — Timer module, activity state, and the cue asset

#### Task W2-A: Implement the wait timer module (clamp, abort, notify)
- **Build:** Create `src/tools/wait-tool.ts` exporting:
  - `export const MAX_WAIT_MS = 2 * 60 * 60 * 1000;`
  - `export const DEFAULT_WAIT_MS = 60_000;`
  - `export function parseWaitDuration(raw: unknown): { ok: true; ms: number } | { ok: false; error: string }` — accepts a string like `30s`, `5m`, `1h30m`, `90m`, or a bare number of seconds. Reject empty, non-finite, `<= 0`, and anything above `MAX_WAIT_MS` with `Error: duration must be between 1s and 2h (got "…")`.
  - `export function formatWaitDuration(ms: number): string` — `30s`, `5m`, `1h30m`; used by the notification preview and the activity row.
  - `export interface WaitCapability { wait(input: { durationMs: number; reason: string; chatId?: string; signal?: AbortSignal }): Promise<string>; }`
  - `export function createWaitCapability(): WaitCapability` — resolves after `durationMs` via `setTimeout`, returns `Timer completed after 5m — <reason>. Continue now.` Rejects with an `AbortError`-named error when `signal` aborts, and clears the timer in both paths. Before resolving, calls `notifyWaitTimerFired({ chatId, reason, durationMs })`.
  - `export function notifyWaitTimerFired(input: { chatId?: string; reason: string; durationMs: number }): void` — resolves the owning chat with `findChatById` (`src/state/sessions`), then calls `pushNotificationOrActiveChatSound({ kind: 'agent_wait', title: chat.name || 'Chat', preview: \`Waiting ${formatWaitDuration(durationMs)} — ${reason}\`, chatId, appId: appIdForChat(chat), dedupeKey: \`wait:${chatId}:${Date.now()}\`, os: true })`. Wrap the whole body in `try/catch` — a notification must never fail a tool call.
  - `export function resetWaitTimersForTests(): void` — clears any pending timers tracked in a module-level `Set`.
- **Test:** Create `test/tools/wait-tool.test.mts` (node:test + `assert/strict`, `tsx` runner like the sibling `test/tools/*.test.mts`). Cases: `parseWaitDuration('5m')` → `300000`; `parseWaitDuration('1h30m')` → `5400000`; `parseWaitDuration('3h')` → `ok: false` with an error mentioning `2h`; `parseWaitDuration('')` → `ok: false`; `parseWaitDuration(90)` → `90000`; `formatWaitDuration(5400000)` → `'1h30m'`. For the capability, use `node:test`'s mock timers or a 20 ms duration: assert the resolved string contains `Timer completed` and the reason, and assert that aborting the signal rejects and leaves no pending timer (`resetWaitTimersForTests` then a `setTimeout(…, 50)` sentinel).
- **Accept:** `await createWaitCapability().wait({ durationMs: 20, reason: 'test' })` resolves with a string starting `Timer completed after`, and `parseWaitDuration('3h')` returns `ok: false`.
- **Touches:** `src/tools/wait-tool.ts`, `test/tools/wait-tool.test.mts`

#### Task W2-B: Add the waiting phase to main-turn activity and the agent activity panel
- **Build:**
  - `src/chat/main-turn-activity.ts` — add `'waiting'` to the `MainTurnPhase` union (line 1). Add `pauseMainTurnActivityForWait(chatId, reason, nowMs = Date.now())` and `resumeMainTurnActivityFromWait(chatId, nowMs = Date.now())`, mirroring `pauseMainTurnActivityForQuestion` / `resumeMainTurnActivityFromQuestion` (lines 75–100): set `phase: 'waiting'`, `currentTool: 'wait'`, `pausedAtMs: nowMs`; resume restores `phase: 'tools'` and rebases `startedAtMs` by the frozen elapsed. Add an optional `waitReason?: string` to `MainTurnActivity` and set it in the pause helper (cleared on resume).
  - `src/state/agent-activity-registry.ts` — add `'waiting'` to `AgentActivityStatus` (line 16). In `mapMainTurnPhase` (line 88) return `'waiting'` for `phase === 'waiting'`. In `mainTurnRowStatus` (line 96) treat `waiting` like `pending_question` (it wins over the question-pending flag). In `mainTurnRowElapsed` (line 104) include `turn.phase === 'waiting'` in the frozen set. In `buildMainTurnRows` (line 136) pass `currentTool` through when `status === 'waiting'`. In `formatAgentActivityStatusLine` (line 287) return `Waiting ${row.waitReason ?? ''}`.trim() for the waiting status — add `waitReason?: string` to `AgentActivityRow` and populate it from `turn.waitReason`.
  - `src/ui/agent-activity-panel.ts` — add a `agent-activity-row--waiting` class alongside the existing status classes near line 383, and a matching rule in the panel stylesheet using `--mn-*` tokens (no hex literals outside `src/styles/tokens.css`).
- **Test:** `npx tsc --noEmit`, then `node --test --test-force-exit test/state/agent-activity-registry.test.mts test/ui/agent-activity-panel.test.mts`. Add cases: after `pauseMainTurnActivityForWait('c1', 'build')`, `buildAgentActivitySnapshot` yields a row with `status === 'waiting'` and `elapsedFrozen === true`; `formatAgentActivityStatusLine(row)` returns `'Waiting build'`; after `resumeMainTurnActivityFromWait('c1')` the row is back to `status === 'tools'` and the elapsed timer ticks again.
- **Accept:** `formatAgentActivityStatusLine` returns `'Waiting build'` for a row produced by `pauseMainTurnActivityForWait('c1', 'build')`, and the row's `elapsedFrozen` is `true`.
- **Touches:** `src/chat/main-turn-activity.ts`, `src/state/agent-activity-registry.ts`, `src/ui/agent-activity-panel.ts`, `src/styles/agent-activity.css`, `test/state/agent-activity-registry.test.mts`, `test/ui/agent-activity-panel.test.mts`

#### Task W2-C: Add the Timer cue asset and sound-pack mapping test
- **Build:**
  - Create `public/sounds/packs/default/timer.wav` — a short (≤ 1 s) mono 44.1 kHz WAV. Generate it with a one-off script rather than committing a binary by hand: `node -e "…"` writing a 440 Hz sine with a 30 ms fade-in/out, or reuse the existing `question.wav` bytes if a distinct cue is not worth synthesizing. The file must be a valid RIFF/WAVE container — `test/notifications/sound-packs.test.mjs` only checks the URL string, so verify the file with `node -e "const b=require('fs').readFileSync('public/sounds/packs/default/timer.wav'); console.log(b.subarray(0,4).toString(), b.subarray(8,12).toString())"` printing `RIFF WAVE`.
  - Confirm `src/notifications/sound-packs.ts` already points `timer` at `./sounds/packs/default/timer.wav` (W1-B). Do not add a second pack.
- **Test:** `node --test --test-force-exit test/notifications/sound-packs.test.mjs` passes, and the RIFF/WAVE check above prints `RIFF WAVE`. Then `npm run build` and confirm `dist/sounds/packs/default/timer.wav` exists (Vite copies `public/` verbatim).
- **Accept:** `node -e "…"` on `public/sounds/packs/default/timer.wav` prints `RIFF WAVE`, and `dist/sounds/packs/default/timer.wav` exists after `npm run build`.
- **Touches:** `public/sounds/packs/default/timer.wav`
- **Depends on:** W1-B

### Wave 3 — Dispatch, wiring, and docs

#### Task W3-A: Dispatch the wait tool in the client executor
- **Build:**
  - `src/tools/client.ts` — import `createWaitCapability`, `parseWaitDuration`, and `formatWaitDuration` from `./wait-tool`. In `executeToolInner`, add a branch immediately after the `ask_question` branch (line 293):
    - Reject when `!isToolEnabled('wait')` with `Error: tool "wait" is disabled in Settings (enable it to let the agent pause on a timer).`
    - `const parsed = parseWaitDuration(args.duration); if (parsed.ok === false) return { content: parsed.error };`
    - `const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'waiting';`
    - Call `blockAfkInteractionAttempt(context, 'other', 'wait was attempted during AFK execution')` — a parked unattended turn is a hang, not a wait. Add `'wait'` to the AFK guard list at line 242 alongside `ask_question`.
    - `return { content: await createWaitCapability().wait({ durationMs: parsed.ms, reason, chatId: context.chatId, signal: context.signal }) };`
    - On an aborted signal, return `{ content: STOPPED_TOOL_MSG }` (already imported at line 1) so the transcript reads like any other stopped tool.
  - `src/chat/run-turn-chat.ts` — in the `onEvent` handler, in the `event.type === 'tool_call'` block (line 1586), after `patchMainTurnActivity(chat.id, { phase: 'tools', currentTool: … })`, add: when `event.name === 'wait'`, call `pauseMainTurnActivityForWait(chat.id, resolveWaitReasonFromArgs(event.arguments))`. In the `event.type === 'tool_result'` handling, when `event.name === 'wait'`, call `resumeMainTurnActivityFromWait(chat.id)`. Import both helpers from `./main-turn-activity` (the import block is at line 132). `resolveWaitReasonFromArgs` is a small local helper that JSON-parses `event.arguments` defensively and returns `args.reason` or `'waiting'`.
  - Do **not** add `wait` to `server/runner/tool-set.js`. It is a renderer tool; `RENDERER_ONLY_TOOL_IDS` is the correct home if a later task needs to name it, but this plan leaves the headless lists untouched.
- **Test:** `npx tsc --noEmit`, then `node --test --test-force-exit test/tools/wait-tool.test.mts test/chat/abandoned-turn-activity.test.mts`. Add a case to `test/tools/wait-tool.test.mts` that calls `executeTool('wait', { duration: '1s', reason: 'smoke' })` with a stubbed capability and asserts the returned `content` starts with `Timer completed`. Note: `test/chat/abandoned-turn-activity.test.mts` currently fails on `main` for an unrelated happy-dom `dispatchEvent` reason (see the pre-existing-failures note) — treat it as a regression check only, not a green gate.
- **Accept:** `executeTool('wait', { duration: '1s', reason: 'smoke' })` returns content starting with `Timer completed after`, and `executeTool('wait', { duration: '3h', reason: 'x' })` returns an error mentioning `2h`.
- **Touches:** `src/tools/client.ts`, `src/chat/run-turn-chat.ts`
- **Depends on:** W1-A, W2-A, W2-B

#### Task W3-B: Document the wait tool in the shipped manual and context.md
- **Build:**
  - `documentation/manual/reference/tools.md` — add a `wait` row to the Utility table (the table that currently lists `get_datetime`, `calculate`, clipboard). Columns match the existing rows. Description: pauses the turn for a duration and continues automatically; maximum 2 hours; the agent is notified through the menubar bell when the timer fires. Present tense, shipped behavior only — no roadmap language.
  - `documentation/context.md` — update the built-in tool count in the AGENTS.md-style summary if it appears there (search for `103 built-in tools`), and add a short paragraph to the operating-modes section describing the `wait` tool: blocking tool call, 2 h cap, `agent_wait` notification kind in the Chat group, `waiting` activity phase, chat-only (headless lists unchanged).
  - Do **not** touch `documentation/ROADMAP.md` — this ships.
- **Test:** `npm run test:product-wiki` (the product-wiki suite asserts the manual and tool catalog agree), then `grep -n "wait" documentation/manual/reference/tools.md` and confirm exactly one new row. Run `node --test --test-force-exit test/ui/product-wiki.test.mts`.
- **Accept:** `npm run test:product-wiki` passes and `documentation/manual/reference/tools.md` contains a `wait` row.
- **Touches:** `documentation/manual/reference/tools.md`, `documentation/context.md`
- **Depends on:** W1-A

## Verification Checklist

- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes — excluding the known pre-existing failures on `main` (`test/chat/abandoned-turn-activity.test.mts`, `test/tools/loop-resume.test.mts`, `test/tools/tool-start-indicator-remount.test.mts` — happy-dom `dispatchEvent` realm issue; `test/config/editor-ai-completion-meta.test.js`; the fake LSP formatting fixture)
- [ ] `npm run test:modes` passes — every built-in tool belongs to a group and every mode's group expansion covers its policy
- [ ] `npm run test:product-wiki` passes
- [ ] `npm run build` passes and `dist/sounds/packs/default/timer.wav` exists
- [ ] `npm run check:performance-budgets` passes (the new tool schema is ~120 bytes of JSON; the cue is ≤ 100 KB)
- [ ] Manual smoke in `npm start`: ask an agent to `wait 10s` and confirm (a) the activity panel shows `Waiting 10s — <reason>` with a frozen timer, (b) the menubar bell gets an `agent_wait` row with the Timer cue, (c) the turn continues in the same transcript with a `Timer completed after 10s` tool result
- [ ] Manual smoke: press Stop mid-wait and confirm the turn ends with the stopped-tool message and no notification fires afterwards

## Notes for Build Agents

- **`server/tools/builtin-catalog.js` is the single source of truth** for the tool catalog. `src/tools/definitions.ts:47` re-exports it. Edit the server file, never a client copy.
- **The mode matrix is deny-by-default.** A tool that is in `BUILT_IN_TOOLS` but in no `MODE_ALLOWED_GROUPS` row is invisible to every mode. `test/modes/tool-policy.test.mts:271` fails loudly if a built-in tool is missing from `TOOL_GROUP_IDS` — that is the guard, not an obstacle.
- **Three records are exhaustiveness-checked** and will fail `tsc` if the new kind is missing: `KIND_GROUP` in `src/notifications/prefs.ts`, `NOTIFICATION_KIND_TO_CUE` in `src/notifications/sound-packs.ts`, and the `NotificationKind` union itself. Let the compiler drive W1-B.
- **Match the `ask_question` shape, not a new one.** `withAskQuestionTool` (`server/runner/ask-question-tool.js:84`) and the in-loop branch at `server/runner/run-turn.js:595` are the reference implementation for a tool that parks a turn and returns a result. Do not add a new event type or a new runner option.
- **Never let a notification break a tool call.** `notifyWaitTimerFired` wraps everything in `try/catch`; `notifyChatTurnEnded`'s call site (`src/chat/run-turn-chat.ts:1935`) does the same for the same reason.
- **Icons:** if the activity panel needs a waiting glyph, use `@flaticon/flaticon-uicons` following the existing icon conventions in `src/ui/agent-activity-panel.ts`. No emoji.
- **CSS:** application styles use `--mn-*` tokens; hex/rgba literals belong only in `src/styles/tokens.css`.
- **Copy:** user-facing strings describe shipped behavior in the present tense. No "coming soon", no competitor comparisons.
- **Do not stage build output.** `dist/` and `release/` are generated; scope diffs to source.
