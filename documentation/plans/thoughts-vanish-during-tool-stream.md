# Keep thoughts visible while tool calls stream

## Status

Shipped in this change.

## Todos

- [x] Settle live thoughts on `reasoning_end` instead of removing the panel until `round_end`
- [x] Preserve expanded/collapsed state and duration label across that settle
- [x] Tests: thoughts remain in the assistant row through `tool_streaming` / `tool_call`
- [x] Update `documentation/context.md`

## Goal

When a model finishes reasoning and starts writing a tool call, the latest thoughts stay on screen. They should not vanish and then reappear after the tool card lands.

## Failure mode

`TurnEvent.reasoning_end` fires as soon as the runner leaves the reasoning channel (first prose, first `tool_calls` delta, or a thinking-channel `<tool_call>`). `ThoughtBubbleController.endReasoningPhase` then **removes** the live `.thought-stage`. Persisted "Thought for" chrome is only painted later:

- tool-bearing rounds: `round_end` → `finalizeAndAnchorThinkingRound` (after the last `tool_result`)
- prose-only rounds: turn-end in `runChatTurn`

During `tool_streaming` ("Calling …") the thoughts are gone even though the text is still in the controller.

## Approach

On `endReasoningPhase`, flush the open buffer, drop the live stage, and immediately `renderThoughtsToggle` on the same assistant row (keep expanded state and `elapsedMs`). Do **not** consume segments yet — persistence and `round_end` still read the controller. `renderThoughtsToggle` is a no-op if a panel already exists, so the later finalize path will not flicker a second mount.
