# Antislop pattern census

Count copyable anti-patterns across first-party code. Agents copy whatever looks established, so a pattern's spread matters as much as any single instance. The census is cheap and deterministic: run it before the manual sweep and use hotspots to choose where to read deeply.

## Method

1. Scope: first-party source, scripts and tests from the inventory. Exclude generated, vendored and fixture trees. Count tests separately from product code.
2. For each applicable pattern below, use a language-aware search (`git grep -n -E`, `rg`, or an existing lint/AST tool when available). Adapt patterns to the languages actually present; skip ones that don't apply and say why.
3. Record total hits, files, top 5 hotspot files or directories, and any existing suppression or allowlist.
4. Sample at least 10 hits per pattern (all if fewer) and classify them as harmful, acceptable, or false match. Report estimated precision. Don't call a pattern a problem from counts alone.
5. For patterns with high precision and real harm, propose a guardrail: the exact rule (existing lint rule, import restriction, custom check or test), an example it should flag, an example it must allow, the error message pointing to the right fix, and a **ratchet** (baseline the current count or allowlist current files so no new occurrences appear, then burn down). Prefer extending an existing lint/test/CI gate to adding a new system.
6. In Diff mode, count only changed files at base and head and report new occurrences.

## Patterns

| Pattern | Typical signals | Why it spreads harm |
| --- | --- | --- |
| Timing patches | `setTimeout(…, 0)`, nested `requestAnimationFrame`, `requestIdleCallback`, `queueMicrotask`, sleep/delay helpers used to wait for state | Masks ordering bugs; timer churn costs GC and jank; copied as the "fix" for every race |
| Swallowed errors | `catch {}`, `catch (_) {}`, `.catch(() => {})`, `except: pass`, ignored error returns | Hides failures, makes optimistic success look real |
| Floating promises | `void someAsync()` and unawaited calls with no owner or error path | Work outlives its view; errors vanish |
| Type escapes | `as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error` without a reason, non-null `!` chains | Removes the type system's guarantees exactly where code is uncertain |
| Lint suppressions | `eslint-disable`, `noqa`, `nolint`, `#[allow(...)]` | Each one is an exception agents treat as precedent |
| Justifying comments | Comments with "workaround", "hack", "for now", "temporary", "quick fix", "TODO", "FIXME", "XXX", "needed because" | Prose escape hatches that rationalize violating an invariant |
| Global listeners and pollers | `addEventListener` on `window`/`document`, `setInterval`, observers, without a matching removal in the same owner | Leaks and stale updates after navigation |
| Framework effects (React etc.) | `useEffect`/`useLayoutEffect` computing derived state, syncing props to state, or firing events | Classic misuse; usually replaceable by derivation or event handlers |
| Layer crossings | Renderer importing main/server/Node modules, or the reverse; cyclic imports | Wrong-runtime code, jank, hidden coupling |
| Duplicated helpers | Several near-identical utilities (debounce, path normalize, retry, formatting) | Divergent behavior; agents pick a random copy |
| Debug leftovers | `console.log`, `debugger`, `print(` in product paths | Noise and data exposure |
| Disabled or skipped tests | `.skip`, `.only`, `xit`, `@skip`, commented-out tests | Coverage silently shrinks |

Add project-specific patterns when contributor guidance names a rule (for example, a required helper or banned API) and check that it is followed.

## Report

Write a census table in the report: pattern, hits (product/test), files, precision from the sample, hotspots, existing guard, and proposed guardrail with ratchet. Put the top 1–3 guardrails in the executive summary. Hits with concrete harm become Phase 4 candidates; record them with census references.
