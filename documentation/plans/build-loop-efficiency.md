# Build-loop efficiency follow-up

Based on the five September 22 chat traces: 18–65 calls before the first edit, repeated reads across compaction, and 33–69 seconds per run in configuration refresh.

## Implementation

1. Use a 30-second freshness window for per-round MCP discovery. Coalesce concurrent requests; settings callers retain forced refresh. Recompute tool permissions and mode filtering every round.
2. Retain bounded historical source excerpts with recall row references in shortened read results and compaction state. Preserve explicitly labeled assistant hypotheses and acceptance results as claims, not verified facts. Invalidate a file's observations on recorded writes.
3. Update full/lite chat and board build guidance to form a hypothesis, next edit, and acceptance check after the first focused read batch. Add a six-call runtime checkpoint before the existing 12-call reminders.
4. Give advisory browser checkpoints every four calls and after three consecutive failures. Keep probes available for required verification. Preserve explicit test requirements and never turn an unverified result into a pass.

## Validation

Test discovery freshness/concurrency/forced refresh/failure, old compaction-state compatibility, bounded excerpts and repeated folds, edit invalidation, advisory checkpoints and continued editing, and prompt coverage for both profiles. Run runner and compaction regressions, typecheck, build, coverage discovery, and bundle budgets.

## Live acceptance

After restart, compare similar tasks for calls/time to first edit, repeat reads across compaction, configuration-refresh time, and whether verification demonstrates the requested behavior. The first live trial exposed failed runs at the hard 48-call cutoff and repeated compaction near 50k; both defaults were revised before a speedup claim.
