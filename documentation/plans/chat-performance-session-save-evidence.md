# Step 9 — session persistence evidence

Measured 2026-11-07 on Windows x64, Node v24.19.0, Intel Core i9-14900K. Synthetic fixtures only; no live settings or profile mutation and no commits.

## Implemented persistence boundary

- Managed session writes allow only id, name, groupId, pinnedAt, archivedAt, composerDraft and updatedAt. Canonical history, execution metadata and run details are never read by config save projection. Direct PUT/PATCH, beacons and keepalive fallbacks use the same projection.
- Chat/group/scalar dirty versions are acknowledged independently. An edit to B cannot resend a successfully saved A; same-entity edits and deletes arriving during the request remain dirty. Existing conflict recovery and presentation CAS remain in effect.
- API conflict rebases reuse one serialized snapshot, changing only the outer base revision. An in-flight nested legacy edit cannot change the retried request.
- Production saves no longer baseline or verify whole-chat hashes. Development diagnostics sample bounded metadata, excluding all transcript/run bodies.
- Stale managed no-op metadata recovery checks do not fetch message bodies. Genuine conflicting edits still preserve the displaced transcript/draft atomically. Existing legacy incremental row reconciliation is unchanged.

## Deterministic operation gates and component measurements

`test/fixtures/long-chat-history.mjs` generates stable prose, fenced code, reasoning and usage. Renderer-side tests install guarded canonical-field getters and assert zero reads, including with development diagnostics enabled. SQL tests persist the real fixture and compare every message row and search row before/after metadata saves. A file-backed 2500-row reopen test preserves payloads, rowids, sequence numbers and row hashes.

| Messages | Serialized synthetic history bytes | First managed PATCH bytes | Canonical body reads | SQL statements for 3 metadata saves | Warm Node synchronous save p50 / p95 ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 40,362 | 139 | 0 | 63 | 0.024 / 0.068 |
| 100 | 403,738 | 139 | 0 | 63 | 0.020 / 0.088 |
| 2500 | 10,099,589 | 139 | 0 | 63 | 0.015 / 0.068 |

Five warmup saves followed by 25 measured saves per renderer-side fixture. Fetch is deterministic/in-process. First-write payload size excludes later numeric revision growth; counts/size equality and zero body reads are assertions, timings are observations, not CI thresholds. SQL component times for three saves were 1.181 / 1.554 / 1.099 ms respectively; seeding/reconstruction/reopen/assertion costs are excluded from those intervals. These are Node component probes, not Electron renderer, typing, compositor or end-to-end profiles. No fixed speedup or release latency target is claimed.

Reproduce the component probes:

```sh
node --import tsx --import ./test/test-loader.mjs --test --test-force-exit test/state/session-save-scaling.test.mts test/config/sessions-message-sync.test.js
```

## Checks

- Latest focused persistence/CAS/conflict suite: **89 passed** across session-save-scaling, dirty-tracking, multi-window, persistence, presentation-client, presentation-revisions and sessions-message-sync. Subsequent warmed component probes: **13 passed**.
- Broader persistence/history/search/reload/backoff/lazy-history/restart checks: **142 passed** before adding the reopen test; the added reopen test passes in the component/focused suites above.
- Activity/request-attention, chat-app scope, JSON store, chat detail and summaries: **50 passed**.
- `npx tsc --noEmit`: passed; affected source LSP diagnostics show no errors.
- `npm run test:check-coverage`: passed (1925 files on disk, 1922 included, 3 exclusions at time of check).
- Scoped `git diff --check`: passed; Git noted the existing LF-to-CRLF conversion policy for sessions-message-sync.test.js.

## Integration handoff / limits

The extra renderer `failed-turn-partial.test.mts` and `finalize-stopped-turn.test.mts` integration runs fail before their fake runner, with `Failed to parse URL from /api/config/meta`. `buildComposeContext` awaits prompt metadata and the concurrent preparation change in `run-turn-chat.ts` now propagates composition failures instead of using its old fallback; these fixtures do not stub that fetch. Those files were not modified here. The preparation/migration owner must adapt the fixtures or verify its intended behavior; this report does not call the full suite green.

No managed bridge/presentation/subscriber files were changed; bounded stream batches, inactive-view subscriptions, final flush and real renderer typing/paint profiling remain with their owners. Legacy full-transcript wire compatibility remains; this slice does not introduce a separate changed-message wire protocol. Existing server row-level reconciliation and immutable unchanged-row identities are retained and tested.
