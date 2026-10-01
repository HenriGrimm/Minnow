# MIN-38: Change reasoning while a board runs

## Plan

1. Keep the board reasoning effort selector and thinking toggle available during a run, respecting the selected model's capabilities.
2. Reuse the existing journaled model command; changing reasoning does not stop or restart the board.
3. Capture reasoning effort in each attempt's transcript metadata so the shared completion runner honors low, medium, and high.
4. Explain that changes affect new attempts; running attempts keep their existing setting.
5. Verify both live UI interaction and the runner's per-attempt snapshot behavior.

## Acceptance

- A running board can change reasoning effort or switch reasoning on/off.
- The board remains running and active attempts are not cancelled.
- Subsequent attempts use the newly journaled setting.
- Selected effort survives into the shared runner's completion metadata.
