# Model bench: Flip Match v1

Standardized prompt for comparing models on **Plan**, **Build**, and **Orchestrate board** workflows. Use the same spec across models so results are comparable.

**Bench ID:** `bench-flip-match-v1`  
**Output folder:** `sandbox/bench-flip-match/`  
**Plan artifact (Plan mode):** `documentation/plans/bench-flip-match.md`

---

## Why Flip Match

A 4-pair (8-card) memory game. Every model knows the rules, the work splits cleanly into six board tasks, and you can verify objectively with file reads plus a small `node:test` suite.

| Criterion | Why it works |
|-----------|--------------|
| Standalone | `sandbox/bench-flip-match/` only — no Minnow app changes |
| Simple | ~6 files, vanilla TS, no framework |
| Plan-friendly | Natural waves and dependencies |
| Board-friendly | Maps 1:1 to quick/smoke preset shape (parallel W1, dependent W2, polish W3) |
| Gradable | Logic tests + visual checklist |

---

## Copy-paste master prompt

Use this verbatim when starting a bench run:

```markdown
# Model bench: Flip Match v1

Build a **standalone browser mini-game** called **Flip Match** — a memory card game where the player flips two cards per turn to find matching pairs.

## Constraints (non-negotiable)

- **Location:** all code under `sandbox/bench-flip-match/` — do not modify files outside this folder.
- **Stack:** vanilla HTML + CSS + TypeScript (ES modules). **No** React, Vue, or new npm dependencies.
- **Scope:** exactly **4 pairs** (8 cards). Labels: `A`, `B`, `C`, `D` (shown on card faces).
- **Assets:** no external images or CDN links. Use CSS + text/emoji only.
- **Theme:** dark background, cards with a visible flip animation (CSS `transform` or similar).
- **Deliverable:** opening `sandbox/bench-flip-match/index.html` in a browser must be playable without a build step.

## Game rules

1. Board starts face-down, shuffled.
2. Player clicks a card → it flips face-up.
3. Second click → if labels match, both stay face-up; if not, flip both back after **600 ms**.
4. Track **moves** (one move = two flips).
5. When all 4 pairs are matched, show a **win overlay** (“You won in N moves”) with a **New Game** button.
6. **New Game** reshuffles and resets moves.

## File structure (target)

```
sandbox/bench-flip-match/
  index.html          # entry, imports ui.ts as module
  styles.css
  src/
    deck.ts           # createDeck(), shuffle()
    game.ts           # GameState: flip, match check, win detection
    ui.ts             # render grid, wire click handlers, win overlay
  test/
    game.test.mts     # node:test — deck size, shuffle changes order, match logic
  README.md           # how to open + how to run tests
```

## Acceptance criteria (all must pass)

- [ ] `sandbox/bench-flip-match/` contains only the files above (± README).
- [ ] `createDeck()` returns 8 cards with exactly 2 of each label A–D.
- [ ] `shuffle()` produces a different order than the unshuffled deck (use seeded RNG in tests if needed).
- [ ] Game prevents flipping a third card while two mismatched cards are waiting to flip back.
- [ ] Win overlay appears only when all pairs matched.
- [ ] New Game resets board, moves, and overlay.
- [ ] `node --import tsx --test sandbox/bench-flip-match/test/game.test.mts` exits 0.
- [ ] README documents: open `index.html` in browser; run the test command above.

## Out of scope (do not build)

- Score persistence / localStorage
- Sound, multiplayer, timers, difficulty levels
- Animations beyond card flip
- Integration with the Minnow app

## If planning (Plan mode)

Save the plan to `documentation/plans/bench-flip-match.md` with **medium** granularity and this wave structure:

| Wave | Task ID | Title | Depends on |
|------|---------|-------|------------|
| W1 | W1-A | Deck module (`deck.ts`) | — |
| W1 | W1-B | Game state machine (`game.ts`) | — |
| W1 | W1-C | Card grid styles + flip animation (`styles.css`) | — |
| W2 | W2-A | UI renderer + click wiring (`ui.ts`, `index.html`) | W1-A, W1-B, W1-C |
| W2 | W2-B | README + manual smoke checklist | W2-A |
| W3 | W3-A | Unit tests (`test/game.test.mts`) | W2-A |

Each task needs explicit **Build** and **Test** specs (what file to create/change; how to verify — read file, run test command, or browser check).

Do not implement until the plan is approved.
```

---

## Phase-specific variants

### Plan mode only

Prepend to the master prompt:

> You are in Plan mode. Produce only `documentation/plans/bench-flip-match.md`. Do not create `sandbox/` files yet.

### Build mode only (single-shot, no board)

> Implement the full Flip Match spec below in one session. When done, run the test command and confirm all acceptance criteria.

Then paste the master prompt body.

### Orchestrate board

After the plan exists:

> Orchestrate `documentation/plans/bench-flip-match.md` on this workspace. AFK mode. Each builder owns only its task's files. Final integration: all tests pass + browser smoke.

This aligns with the quick (3 parallel W1) and smoke (3 waves, dependencies) presets in [`src/dev/orchestrate-scenarios/`](../../src/dev/orchestrate-scenarios/).

---

## Verification (operator checklist)

After any run:

```bash
# Logic tests
node --import tsx --test sandbox/bench-flip-match/test/game.test.mts

# Structure check
test -f sandbox/bench-flip-match/index.html \
  -a -f sandbox/bench-flip-match/src/deck.ts \
  -a -f sandbox/bench-flip-match/src/game.ts \
  -a -f sandbox/bench-flip-match/src/ui.ts
```

After orchestration, validate the board log (substitute your `groupId`):

```bash
npm run check:board-log -- <groupId> --plan documentation/plans/bench-flip-match-board.json
```

Minimal plan graph for `check-board-log`:

```json
{
  "tasks": [
    { "id": "W1-A", "wave": "W1" },
    { "id": "W1-B", "wave": "W1" },
    { "id": "W1-C", "wave": "W1" },
    { "id": "W2-A", "wave": "W2", "dependsOn": ["W1-A", "W1-B", "W1-C"] },
    { "id": "W2-B", "wave": "W2", "dependsOn": ["W2-A"] },
    { "id": "W3-A", "wave": "W3", "dependsOn": ["W2-A"] }
  ],
  "waveOrder": ["W1", "W2", "W3"],
  "expectFinalTest": true
}
```

Save that JSON as `documentation/plans/bench-flip-match-board.json` when you want repeatable log validation.

---

## Model comparison rubric

Score each model **0–2** per row (0 = fail, 1 = partial, 2 = clean). Max **10** points per run.

| Dimension | Pass signal |
|-----------|-------------|
| **Planning** | Plan has waves, deps, per-task Build/Test, no scope creep |
| **Building** | All acceptance criteria green; tests pass |
| **Orchestration** | Board completes; no quarantine; W2 waits for W1 |
| **Code quality** | Small modules, no globals, readable names |
| **Recovery** | Tester fail → rebuild succeeds within retry cap |

---

## Suggested workflow

1. **Plan** — run master prompt in Plan mode with different models; compare plan quality.
2. **Build** — same prompt in Build mode (no board); compare one-shot completion.
3. **Orchestrate** — feed the plan to a board; compare convergence time, retries, quarantines.


---

## Faster alternative: Reaction Tap (`bench-reaction-tap-v1`)

For a **~5 minute smoke** before the full game bench:

- One HTML file + one `game.ts`: wait random 1–3s, turn background green, measure reaction time in ms, show result, **Play again**.
- Three board tasks max (logic / UI / README).
- Good for “can this model ship anything?” — less discriminating than Flip Match.
