# Compact chat: turn summary

**Status:** building (2026-09-14) · **Files:** `src/chat/turn-summary.ts`, `src/ui/chat-work.ts`, `src/styles/chat-thread.css`

## Problem

In compact view a collapsed turn showed `Worked for 2m · 17 tool calls`, and the only
rows left visible were compaction dividers and failed tool calls. Those are the least
informative things in a turn, and a failure the model retried and fixed still looked
like it needed the user.

## Decisions (settled with Henri, 2026-09-14)

1. **Per turn**, not a whole-chat recap. The summary lives on the existing `.chat-work` button.
2. **Deterministic.** No model call. Built from `chat.history` by a pure `summarizeTurn()`.
3. **Failures:** a tool failure the model later recovered from is silent. Failure rows
   stay visible only when the turn itself ended failed or stopped.
4. **Built live** while the turn runs.
5. **Tally, not a timeline:** `Read 6 files · 3 searches · Edited 2 files · Ran 4 commands`.
6. **Narration** (prose on tool-call rounds) is used only while live, see 9.
7. **Recovered** = a later call in the same turn with the same tool and same target
   succeeded. Unrecovered failures attach to their tally entry in danger ink: `Ran 4 commands · 1 failed`.
8. **Full view** hides the tally (every row is already visible). **Sub-agents** are a tally
   entry (`Spawned 2 agents · 1 running`); their cards hide with the rest of the work.
9. **Live second line:** latest narration only if the model narrated in the *current* round,
   else the running tool, else `Thinking`, else `Generating response` (plus runtime detail).
10. Tally counts **distinct targets**, fixed order Read → Search → Edit → Run → Browse → Web →
    Agents → Asked → Other → Compacted. At most 4 entries, then `+N more`. Entries with
    unrecovered failures are never pushed into `+N more`. Edits show a file count only (the
    changes card has the line counts). Commands are counted, not named.
11. Recovered failures leave no trace (`1 retried` is not shown).
12. **Compaction:** superseded checkpoints fold into the tally (`Compacted`) and their dividers
    hide while collapsed. The single active divider stays a visible, expandable line.
13. **End reasons** in the label: `Worked for`, `Failed after`, `Hit tool limit after`
    (`endReason: max_tool_turns`), `Stopped by you after` / `Timed out after` / `Interrupted after`
    (`stopReason` user / timeout / system).
14. Summary follows the active branch (it reads `chat.history`, which only holds that branch).

Also: answered `ask_question` → `Asked N questions`; a turn with thinking but no tools →
`Thought` (`Thought for 12s` when `thinkingDurationMs` is recorded); tools outside the known
families count under `Other`; an unloaded history (`historyLoaded === false`) shows no button.

## Failure detection

Same rule as the tool row (`isToolResultFailure`): the result starts with `Error:`, except an
Impeccable detect run with findings. A non-zero exit that the runner does not report as
`Error:` is not a failure here either, so the tally never disagrees with the row it summarizes.

## Not in scope

- Model-written summaries.
- A chat-wide "story so far".
- `transcript-view.ts` (the orchestrator task transcript) keeps its current dividers.
