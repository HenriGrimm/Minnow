# Context compaction v2: deterministic checkpoints + recall

Status: plan (2026-09-13), decisions settled (§8). Phases 0–2 implemented (2026-09-13). `recall_history` (the runner-side tool from Phase 3) landed with Phase 2 because summaries and stubs cite it; the rest of Phase 3 (server route, retiring `recall_chat_context` / `recall_turn_full` / `src/chat/archive/`) and Phase 4 (UI, settings) are not started.

## TL;DR

Context compression isn't failing in one place. There are **four separate failures** that stack up:

1. **The unit is wrong.** `partitionTurns` treats every assistant/tool round as its own "turn". So `minRecentTurns: 2` keeps the last two tool rounds, and the user's actual request can get dropped.
2. **Nothing is ever checkpointed.** Every send, and every tool round, rebuilds the trim from the full history. That means a new summary each time, a changed prompt prefix each time, and a full re-prefill on llama.cpp.
3. **The summarizer is either off or garbage.** On llama.cpp/mlx, "summarize" is swapped for an extractive head/tail slice of raw text and tool JSON (512 tokens). On hosted models the LLM call gets the entire dropped text with a 1024-token cap, and any overflow, timeout or thinking-only reply silently falls back to that same slice.
4. **Server-side agents have no context management at all.** Boards, sub-agents and Super Plan stages run the default `summarize` policy through `applyContextBudget`, which **no-ops** on `summarize`. They also usually have no model limit, so the overflow retry runs a no-op and then throws.

Orchestrator V2 P6 (`1d6f94d8`) deleted `src/tools/loop.ts`. That also removed the only callers of the automatic context notice and of the Brain archive policy. Auto-trims are now invisible, and `recall_chat_context` searches an archive that nothing writes anymore.

**VCC verdict:** don't adopt [lllyasviel/VCC](https://github.com/lllyasviel/VCC) itself. It compiles Claude Code JSONL logs into views and ships `/recall` skills; it isn't a compaction engine and only reads Claude Code's format. Its core idea is right, though: keep the log lossless, give the model projected views, and let it recall details through pointers. Minnow already has the lossless half, because `chat.history` persists append-only and the runner only trims its in-memory copy. [pi-vcc](https://pi.dev/packages/@monotykamary/pi-vcc) (MIT) is the model to follow. It does compaction with no LLM call: structured sections, deterministic output, milliseconds per run, a stable prefix for caching, plus a recall tool over the raw history. **Port its design; don't depend on the package.** It's built around Pi's session JSONL and tool names, while Minnow has richer signals (`codeChange` stats, `todo_write`, git tools, exit codes) and an FTS5 index (`messages_fts`, bm25) already sitting in SQLite.

For Minnow, deterministic compaction beats LLM summarization on every axis that matters. llama.cpp/mlx run `--parallel 1`, so a second completion fights the only slot, which is why it's disabled there today. A deterministic summary is also byte-stable, so the KV cache and Anthropic prompt cache survive. It doesn't need a 45s timeout. And exact details come back through recall, not through hoping a summarizer kept them.

---

## 1. How it works today

| Stage | Where | What it does |
|---|---|---|
| Policy resolve | `src/chat/resolve-context-policy.ts` | user override → global → shipped; default `summarize` |
| Window | `src/chat/run-turn-chat.ts:497` `turnModelContextLimit` | served `-c`, else model row |
| Pre-send, per round | `server/runner/sub-agent-runner.js:856` `enforceContextBudget` | prune superseded screenshots → `deps.applyContextPolicy` → `replaceMessages` (rowShift) |
| Renderer policy | `src/chat/context/apply-policy.ts` | `summarize`: local → `dropMiddle`; hosted → `summarizeDroppedTurns` (LLM) → fallbacks |
| Sync policies | `server/runner/context-budget.js:444` `applyContextBudget` | truncate / slide / archive(=slide) / dropMiddle; `summarize` → **no-op** |
| Overflow retry | `sub-agent-runner.js:1262` | parse provider numbers → re-enforce at retry limit → retry ≤2 |
| Manual | `src/chat/context/compress-command.ts` | `/compress`: LLM summary, **rewrites `chat.history`** |
| Ring estimate | `src/chat/prompts/token-estimate.ts:150` | `estimateContextPolicyTrim` |
| Persistence | `server/runner/run-turn.js:404` `persistNewMessages` | append-only, index-aligned via rowShift; the trimmed copy is never persisted |

Existing tests pass (48/48 across the apply-policy, compress, budget, llm-summarize, notice and overflow-retry suites). The defects below are design gaps the tests don't cover.

## 2. Confirmed defects

Reproduced with a 12-round tool loop (≈32k est. tokens) against a 12k window:

```
dropMiddle  kept s u a t a t a t   summary = "Please refactor…\n\n[{\"id\":\"c0\",\"type\":\"function\"…"
summarize   applied=false          (applyContextBudget path — what every server runner uses)
slide       kept s a t a t a t     user request DROPPED
```

| # | Severity | Defect | Evidence |
|---|---|---|---|
| D1 | P0 | "Turn" = unit. Each assistant+tool round is its own turn, so `minRecentTurns` counts rounds and the latest user request is droppable | `context-budget.js:198-217`; repro above |
| D2 | P0 | Server runners never trim: `summarize` no-ops in `applyContextBudget`; orchestrator effector passes a no-op policy and `resolveModelContextLimit: () => null`; sub-agents only get a limit from `typeRow.maxInputTokens`; Super Plan passes `modelLimit: null` | `context-budget.js:466`, `orchestrator/effector-runner.js:119-123`, `sub-agents/effector-runner.js:701,767`, `super-plan/agent-stage.js:96,123` |
| D3 | P0 | Overflow retry on those runners calls the no-op, so `fit=false` and the turn throws | `sub-agent-runner.js:1276-1291` |
| D4 | P0 | No checkpoint: trim is recomputed from full history on every send and every round. Hosted chats pay a new LLM summary call per send; every model gets a shifting prefix, so llama.cpp re-prefills the whole prompt (inferred from the code path, not yet measured) | `session-transcript-store.ts:11` loads full history; `sub-agent-runner.js:1077` enforces each round |
| D5 | P1 | Local providers never get a real summary: `summarize` → `dropMiddle` → head 40% / tail 40% of concatenated raw text, including tool-call JSON, with no role labels, capped at 512 tokens | `apply-policy.ts:166`, `context-budget.js:272-290` |
| D6 | P1 | Hosted LLM summary is fragile. The whole dropped text is sent (can exceed the window itself), `max_tokens = min(2048, 2×512) = 1024`, thinking isn't disabled (a reasoning-only reply → `''` → fallback), there's a 45s timeout, and output is hard-cut at 2048 chars mid-sentence | `llm-summarize.ts:16,137,141,174-182` |
| D7 | P1 | `/compress` is destructive and index-buggy: it partitions **API rows** and then indexes **history rows**. Tool rows with screenshots expand to 2 API rows, so after the first screenshot the wrong rows are kept (orphaned tool results). It also uses two different filters (`role !== 'context'` vs `isUiOnlyTranscriptRole`), and it overwrites `chat.history`, losing folded rows for good | `compress-command.ts:28,38-52,93`; `token-estimate-core.js:237-238` |
| D8 | P1 | Auto-trims are invisible in main chat: only a transient `setStatus`. No persisted notice and no budget events (loop.ts used to append the notice) | `run-turn-chat.ts:1366-1379`; removed in `1d6f94d8` |
| D9 | P2 | `archive` policy is dead: `applyArchivePolicy` has no callers and the runner treats `archive` as `slide`. `recall_chat_context` is still offered in 6 modes but searches an archive nothing writes | `src/chat/archive/index.ts:76`, `context-budget.js:484`, `src/chat/modes/tool-groups.ts:101` |
| D10 | P2 | Summary is injected as a `user` row. When the kept tail starts with a user row, that's two user messages in a row, and strict-alternation templates (Mistral/Gemma family) reject it | `context-budget.js:391-403` |
| D11 | P2 | Ring estimator builds the budget from the work agent without the resolved policy, so a global override shows a different trim than the send | `token-estimate.ts:166-168` |
| D12 | P2 | `summaryReserveTokens` defaults to 512, far too small for a coding session. pi-vcc lands around 1–2.5k tokens on multi-MB sessions | `apply-policy.ts:50` |

## 3. VCC and pi-vcc, evaluated

| | Current Minnow | lllyasviel/VCC | pi-vcc | **Minnow v2 (proposed)** |
|---|---|---|---|---|
| Kind | trim + LLM/extractive summary | log→view compiler + recall skills | deterministic compactor + recall tool | deterministic checkpoint + recall |
| LLM call | yes (hosted) | no | no | no (optional refine, Phase 5) |
| Lossless source | yes (history), unused | Claude Code JSONL | Pi session JSONL | `chat.history` + `messages_fts` |
| Stable across sends | no | n/a | yes (merge rules, stable-first order) | yes (persisted checkpoint + hysteresis) |
| Local single-slot safe | extractive only | n/a | yes | yes |
| Portable to Minnow | — | no (format-bound) | design yes, code no | — |

Where pi-vcc falls short, and how we cover it:
- It loses nuanced rationale that lives in assistant prose. We keep every user message (capped) plus each turn's final assistant answer (head-capped), and recall covers the rest.
- Its symbol extraction is regex-based and language-limited. We can use `codeChange` stats and tool arguments, and later `repo_map` / `find_symbol` if we want signatures (not in scope).
- License: MIT, compatible with AGPL. If any code is ported verbatim, add it to `THIRD_PARTY_NOTICES.md`.

## 4. Target design

### 4.1 Pipeline (runs in `server/runner`, shared by renderer chat and all server runners)

```
rows ─┬─ project(rows)            apply the latest checkpoint: [system][summary][verbatim tail]
      │
      └─ enforce(projected, window)
           0. prune superseded screenshots (exists)
           1. under high-water (80%)?  → send as-is
           2. elide old tool-result bodies beyond the last K rounds → stubs "#row, tool, size"
           3. still over → CHECKPOINT: fold whole turns before the cut into the structured summary,
              targeting low-water (50%); merge with the previous checkpoint state
           4. current turn alone over budget → fold its older rounds (user request stays verbatim)
           5. last resort → hard-truncate longest row (exists), with a visible notice
```

Hysteresis (80% → 50%) means a checkpoint holds for many sends, so the prompt prefix stays byte-identical between compactions.

### 4.2 Units

- **Turn** = one real user row (not a tool-image follow-up) plus every assistant/tool row up to the next real user row.
- **Round** = assistant row plus its tool results and image follow-ups (today's "turn").
- The cut only lands on turn boundaries, or on round boundaries inside the current turn. The latest real user row is **never** folded out of verbatim context.

### 4.3 Checkpoint row (persisted, lossless)

Reuse `role: 'context'`, which is already UI-only everywhere (renderer filters, sidebar, FTS), and extend `ContextNoticeMessage`:

```ts
interface ContextNoticeMessage {
  role: 'context';
  policy: ContextEnforcementPolicy;
  droppedTurns: number;
  summaryText?: string;
  createdAt: number;
  // v2
  compaction?: {
    version: 1;
    foldThroughIndex: number;   // history index (verify == sessions-repo seq); rows ≤ this are folded
    summary: string;            // exact text sent to the model
    state: CompactionState;     // machine sections for incremental merge
    trigger: 'auto' | 'overflow' | 'manual';
    tokensBefore: number;
    tokensAfter: number;
  };
}
```

- Folded rows stay in `chat.history`. The UI keeps rendering them above a divider, and recall reads them.
- Edit-and-resend / retry truncation (`src/chat/history.ts:37,74`) slices the checkpoint row away along with everything after it, so no invalidation logic is needed.
- The next checkpoint folds only rows in `(prev.foldThroughIndex, newCut]` into `prev.state`: O(new rows), never a full rescan.

### 4.4 Summary format (stable sections first, for caching)

```
## Prior context (compacted — rows #0–#412 folded; full history is searchable with recall_history)
[Session goal]        first user request + later scope changes (verbatim, capped)          sticky
[User notes]          /compact focus text, explicit preferences                            sticky
[Files]               path — read|created|modified (+a/−d from codeChange)                 union
[Commits]             hash subject (git_commit)                                            union, last 8
[Sub-agents]          spawned type → outcome                                               union, capped
[Earlier turns]       #row U: one line → A: one line (tools: read×3 edit×2)               rolling window
[Open problems]       [ERROR]/[WARN] tool errors, exit≠0, tsc/test failures; [RESOLVED]   volatile
[Todos]               latest todo_write state                                              volatile
[Current status]      last assistant conclusion, last file-changing action                 volatile
```

Budget: `min(6k, 12% of window)` tokens by default. Sections are trimmed bottom-up within their caps. Output is pure and deterministic (same rows → same bytes).

Placement: right after pinned system rows, as `role: 'user'`. If the next row is also `user`, merge the summary into that row's content so roles still alternate (D10).

### 4.5 Recall

A single tool, `recall_history`, replaces `recall_chat_context` and absorbs `recall_turn_full`:

```
recall_history({ query?: string, rows?: "120-140", include_tool_results?: boolean, page?: number })
```

- `query` runs FTS5 bm25 over `messages_fts WHERE chat_id = ?` (the index already exists in `server/config/sessions-repo.js`). Hits come back grouped by turn, with `>` markers and `#row` numbers, 5 per page.
- `rows` returns a verbatim slice, with tool bodies windowed (reuse `renderTurnParts`).
- Board attempts and sub-agents have no FTS row; the runner keeps the unprojected array and does in-memory bm25 over it.
- The tool is exposed only once a chat has a checkpoint (or through lazy `search_tools`), which keeps the tool budget flat.

### 4.6 The one tricky invariant: mid-loop checkpoints and rowShift

Persistence is index-aligned (`run-turn.js:404`, and the one-token-chat memory's `rowShift` fix). A checkpoint taken mid-loop must be appended to the store **without** entering the runner's `messages` array:

- New runner input `onCompaction(row)`. `run-turn.js` appends it to the transcript directly, sets `persistCursor += 1` (the same pattern as `onRoundBoundary`), and the runner sets `rowShift += 1`, since the store gained a row that `messages` doesn't have.
- The projection at opening goes through `replaceMessages`, so rowShift accounts for the folded rows.
- A dedicated test covers: checkpoint mid-loop → next tool call and result persist at the right indices → reload reproduces an identical projection.

## 5. Phases

### Phase 0: stop the bleeding (small, ship independently)

| Task | Change | Acceptance |
|---|---|---|
| P0-A | Split `partitionTurns` into `partitionTurns` (real turns) and `partitionRounds`. Slide/dropMiddle/summarize drop whole turns; the latest user row is pinned | Repro above keeps the user request under every policy; tool pairing stays valid |
| P0-B | `applyContextBudget`: treat `summarize` as `dropMiddle` instead of no-op (interim until Phase 1) | Server-runner test: over-window messages shrink |
| P0-C | Server-side window resolution: orchestrator effector, sub-agent effector and Super Plan resolve `modelContextLimit` from the running serve `-c` / model cache / `observedContextWindow` | A board attempt that overflows retries successfully instead of throwing |
| P0-D | Main chat: persist a context notice row and budget events on auto trims (restore the loop.ts behavior) | Notice row appears after a trim; not sent to the model |
| P0-E | `/compress`: partition over history rows, not API rows; one filter | Test with a screenshot tool row before the cut keeps the right rows |

### Phase 1: deterministic compactor (`server/runner/compaction/`)

Hand-port rules apply: `.js` + export block + `.d.ts` (see the runner-extract memory).

- `segment.js`: rows → turns → rounds → tool call/result pairs, keeping history indices.
- `extract.js`: goal/user rows, files (tool args for `read_file`, `save_file`, `replace_text_in_file`, `insert_at_line`, `append_file`, `move_file`, `copy_file`, `delete_path`, plus `codeChange`), commands with exit codes (`execute_command`, `run_python`, `run_javascript`), errors (`Error:` prefix, `isError`, exit≠0, tsc/test patterns) with resolution tracking, `git_commit`, `spawn_sub_agent` outcomes, last `todo_write`, final assistant answers.
- `format.js`: the section layout from 4.4, caps, and the total budget.
- `merge.js`: sticky / volatile / union rules.
- `elide.js`: tool-body stubs for rounds older than K.
- Tests: golden fixtures from 3 real long chats (anonymized), a determinism test, a 3 MB history in < 100 ms, and caps honored.

### Phase 2: checkpoints, projection, hysteresis

- A `compaction` payload on context rows (4.3); `project(rows)` used by the runner's opening path, the estimator (`token-estimate.ts`), and server attempt transcripts.
- Trigger at 80% and target 50%. Overflow → checkpoint against the provider-measured limit × 0.5.
- Mid-loop checkpoint through `onCompaction` (4.6).
- Replace `apply-policy.ts`'s LLM path and `llm-summarize.ts` with the compactor. `/compact` (aliases `/compress`, `/summarize`) writes a manual checkpoint and never rewrites history. Optional trailing text becomes `[User notes]`.
- Tests:
  - Two consecutive sends after a checkpoint produce a **byte-identical message prefix**.
  - Edit/resend below the checkpoint drops it.
  - Latest user row is always verbatim.
  - Output ≤ limit.
  - Pairing is valid.
  - Reload gives an identical projection.

### Phase 3: recall

- Server route `GET /api/sessions/:chatId/recall?q=&rows=&page=` over `messages_fts` and history rows.
- `recall_history` tool (renderer executor + headless executor for runners using the in-memory index).
- Summary header and elision stubs reference `#row` numbers the tool accepts.
- Remove `recall_chat_context`, `recall_turn_full`, `src/chat/archive/`, and the `archive` policy. Update tool groups, `server/config/tool-ids.js`, `home.js`, `tool-set.js` and the benchmark capability entries.

### Phase 4: UI and settings

- Checkpoint divider in the transcript: "Context compacted · 38 turns folded · 142k → 29k tokens", with an expandable summary. Rows above it are labeled "not in model context". A **Compact now** action sits in the context popover.
- Ring and breakdown show the projected size, with summary tokens as their own segment (fixes D11).
- Settings policy select becomes **Compact** (default) / Slide / Truncate. `summarize`, `dropMiddle` and `archive` normalize to `compact` on read (the `normalizeRule` pattern), and the validators are updated. Knobs: high/low water, recent turns kept verbatim, summary budget.
- Sub-agent drawer and board attempt views show checkpoint events.

### Phase 5 (not planned; see §8): model refinement for hosted providers

After a checkpoint persists, a background call rewrites only an `[Decisions]` section. Input is bounded (folded user rows plus final assistant answers, no tool bodies), thinking is off, and `max_tokens` is strict. The refined text is used by the **next** checkpoint's merge, so the current prefix never churns. Never runs on llama.cpp/mlx.

## 6. Evaluation

- **Needle suite:** scripted long sessions with facts planted early (a file path, a decision plus its reason, an error ID, a user preference). After compaction, each fact must be in the summary or retrievable with ≤1 `recall_history` call. Run the current system and v2 on local Qwen and one hosted model.
- **Prefill cost:** llama.cpp serve log `prompt eval` tokens per send across 10 sends after the first compaction. Expect near-zero re-prefill of the prefix with v2, and full re-prefill today.
- **Latency:** compaction p95 < 100 ms. No extra completion calls.

## 7. Invariants (don't regress)

- `chat.history` is never rewritten or shortened by compaction. Checkpoints are appended rows only.
- The latest real user row is always verbatim in the model context.
- Tool-call pairing stays valid after every stage (`sanitizeToolPairing`).
- Compaction output is deterministic, with stable sections ordered before volatile ones.
- rowShift / persistCursor stay aligned across mid-loop checkpoints (4.6).
- No second completion on local single-slot providers.
- `context` rows are never sent to the model except as their projected summary.

## 8. Decisions (settled 2026-09-13)

1. **LLM summarization is deleted.** Phase 2 removes `llm-summarize.ts` and the hosted summarize path in `apply-policy.ts`. Phase 5 is not planned; revisit only as an explicit opt-in if the needle suite shows deterministic summaries missing rationale.
2. **Brain archive policy and `recall_chat_context` are retired** in Phase 3 (with `src/chat/archive/` and `recall_turn_full`).
3. **Folded rows stay visible** in the transcript above the checkpoint divider, labeled "not in model context".
