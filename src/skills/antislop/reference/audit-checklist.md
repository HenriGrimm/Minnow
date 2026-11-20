# Antislop audit checklist

Use relevant lenses on each slice. These are investigation signals, not blanket bans.

| Lens | Look for | Verify or prevent |
| --- | --- | --- |
| Async and lifecycle | Unowned timers, animation/idle callbacks, observers, listeners, pollers and streams; hide vs detach; cleanup after the first await; old callbacks targeting a new mount. In React, investigate derived state or event logic in effects, unstable dependencies, and missing cleanup. | Close/reopen with the same ID, cancel mid-flight, reverse response order. Prefer owned scopes, explicit state transitions and shared cancellation over timing guesses. |
| Writes and shared state | Active chat/workspace/checkout read after an await; multiple caches plus DOM state with unclear authority; premature success, lost drafts, conflict handling, duplicate writes and stale receipts. | Verify actual request targets and ownership on reply. Reject writes, retry, switch while pending, and reorder ACKs. Pin identity and tie success to durable acknowledgement. |
| Entry-point parity | Menus, shortcuts, commands, APIs and deep links implement the same action separately with different guards or recovery. | Trace each path to shared validation, execution and errors. Test multiple entry points. |
| Architecture and contracts | Cycles, side effects on import, wrong-runtime APIs, Electron main/server code in the renderer graph, mismatched schemas, unchecked casts, and competing abstractions without clear ownership. | Walk imports and shared callers. Prefer narrow platform-neutral interfaces, schema validation and specific import restrictions with helpful errors. |
| Errors and recovery | Empty catches, dropped promises, surprising fallbacks, retries without bounds and errors without next steps. | Confirm legitimate best-effort paths before filing. Inject failures at real boundaries and inspect diagnostics, state and user-visible results. |
| Performance | Main-thread I/O/CPU, unbounded work/caches, N+1 calls, unnecessary full DOM rebuilds, timer churn and hidden background work. | Profile representative startup, typing, switching and large inputs before claiming measured impact. Use resource budgets or bounded work counters. |
| UI and accessibility | Click-only controls, broken focus, missing loading/empty/error states, ignored reduced-motion preferences, or narrow layouts that block a flow. | Exercise real flows at desktop and narrow widths with keyboard and reduced motion. Use realistic local data. |
| Defensive boundaries | Weak validation, unsafe defaults, untrusted markup/path handling, sensitive logs and inconsistent permission enforcement. | Inspect defensive checks and use safe fixtures. Do not develop exploits or offensive workflows or exercise live targets. |
| Dead weight and copyable workarounds | Dead routes, shims with no consumers, unused flags/dependencies, helper variants, premature abstractions, and comments or rules excusing an architecture workaround. | Check gates, dynamic callers and external contracts first. Keep comments for real constraints; replace prose-only invariants with APIs, lint, types or tests where enforceable. |
| Verification and delivery | Mocks hide the relevant boundary, assertions check implementation rather than behavior, sleeps hide races, negative paths are absent, or tests aren't discovered by CI. Docs, manifests and generated artifacts drift. | Read test and production paths together. Prefer deterministic fixtures and existing lint/test/build gates to a parallel check system. |

## Evidence and ordering

- **Reproduced:** A safe probe/test or runtime flow demonstrated the failure. Record setup, trigger, expected vs observed result, environment and what was mocked.
- **Source-confirmed:** A traced, reachable path establishes the defect given stated conditions. Cite callers and guards; do not claim measured frequency, timing, or runtime verification.
- **Unverified:** Missing evidence or prerequisite. Exclude it from confirmed counts and issue creation; record a next check and conditional fix.
- **Rejected:** Intentional, mitigated, unreachable, or not materially harmful; record why rather than presenting it as a defect.

Prioritize broad data loss, wrong-target actions and unavailable core flows first (P0/P1 when warranted); then meaningful correctness, usability and resource bugs (P2); then bounded maintenance or performance debt with concrete impact (P3). For prevention, start with making invalid states hard to express, then consider precise static checks or behavior tests. Explain exceptions and false-positive costs. Do not ban all comments, effects or timers on the strength of one misuse.
