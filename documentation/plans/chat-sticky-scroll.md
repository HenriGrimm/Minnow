# Chat sticky-bottom follow scroll

## Status

Shipped in this change.

## Todos

- [x] Diagnose why follow-scroll loses the tail during a live turn
- [x] Unpin only on real upward user input (wheel / keys / scrollbar), not delayed programmatic `scroll`
- [x] Re-pin when the user reaches the tail while scrolling down, and when they click **Jump to latest**
- [x] Do not yank the viewport down when the user is reading above the tail
- [x] Tests for unpin, no accidental re-pin, down-to-tail re-pin, stray scroll while pinned
- [x] Update `documentation/context.md`

## Goal

While a turn is streaming, sitting on (or jumping to) the latest messages should keep the tail in view. Scrolling up to read earlier content must work normally; new tokens must not pull that viewport down.

## Assumptions

- “At the bottom” stays the existing `CHAT_PIN_THRESHOLD_PX` (80px) slack.
- Trackpad jitter: ignore `|deltaY|` under 2px so a 1px bounce does not unpin.
- Same module covers Code `#chatArea`, Chat app, board-init split, and Orchestrate `.ob-chat__scroll`.

## Failure modes in the current code

1. **Up-scroll re-pins inside 80px.** Wheel-up sets `stickToBottom = false`, then the `scroll` handler sets it back to `isChatAtBottom()`. The next stream tick yanks the user to the tail.
2. **Delayed programmatic `scroll` unpins.** After `scrollTop = scrollHeight`, Chromium can fire `scroll` after the programmatic flag clears. If the bubble grew in between, distance > 80px and follow turns off — the transcript “runs away” and the user has to keep chasing it.
3. **Wheel-down never re-pins in the wheel handler.** Catching the tail only happens if a later `scroll` event still reads as at-bottom while content is still growing.

## Approach

- Record user intent (`up` / `down` / `scrub`) from `wheel`, `keydown`, and pointer on the scroll root.
- Unpin immediately on upward intent (so stream ticks cannot fight the gesture).
- Re-pin only on downward/scrub intent **and** `isChatAtBottom`.
- Ignore `scroll` with no user intent: if still pinned, re-glue to the tail; if unpinned, leave the viewport alone.
- `overflow-anchor: none` on transcript scroll roots so Chromium does not fight JS follow.
