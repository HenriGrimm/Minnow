# Minnow performance fixes — October 30, 2026

The two largest sources of navigation stutter are fixed: opening a conversation no longer renders its entire older history in the background, and returning to Code preserves its current transcript when the conversation has not changed. The same real-history stress workloads now stay near a 10 ms p95 animation-frame interval on the evaluation machine, including under artificial 4× CPU throttling.

| Matched workload / measurement | Before | After | Change |
| --- | ---: | ---: | ---: |
| History backfill stress, 4× CPU: p95 frame gap | 58.2 ms | 9.4 ms | 84% lower |
| Same workload: layout + style time | 2,534 ms | 184 ms | 93% lower |
| Same workload: renderer task time | 5,682 ms | 2,154 ms | 62% lower |
| Production history switches, 4× CPU: p95 frame gap | 32.3 ms | 10.1 ms | 69% lower |
| Same production workload: layout + style time | 2,926 ms | 150 ms | 95% lower |
| Same production workload: long tasks ≥50 ms | 14 | 4 | 71% fewer |
| Settled production Code return, large transcript | 61–69 ms | 33–40 ms | Median 43% lower |
| Four-chat prose: median visible text-update interval | 104.8 ms | 35.5 ms | About 3× the update rate |
| Same eight-second workload: live-publication requests | 693 | 157 | 77% fewer |
| Tool-heavy activity: provider catalog requests | 44 | 0 | Repeated catalog reads removed |

The production mixed-app sweep improved from 33.2 ms to 10.2 ms p95 and from six long tasks to zero. This sweep starts with a large chat and includes unsettled history work, so it measures the combined benefit of paging and view retention. Fully warmed app switching was already smooth: p95 was 9.1 ms before and 9.9 ms after, with zero long tasks in both. Native focus during four streams remained around 12–19 ms on return, with zero long tasks; there is no measured native-focus speedup to claim.

History now starts with the latest 30 stored entries. Scrolling upward near the top, or selecting **Show earlier messages**, requests another 30. Rows are constructed in short detached slices, then inserted with one scroll correction per page. Existing rows keep their identity. Switching conversations cancels pending work; minimized windows pause it. Already requested pages survive a same-chat repaint, including a completion received while hidden. This bounds unsolicited rendering; it does not permanently cap the DOM if the reader explicitly loads the entire conversation.

Code reuses the current mounted transcript only while the conversation object, history references, mutation version, mode, and DOM anchor remain current. Local edits and observer updates invalidate that presentation without changing persistence revisions. Tests cover stale histories, replacement DOM, disclosures, scroll position, and view-only observer updates. This retains only the current mounted view, rather than keeping detached transcripts for every chat.

Streaming uses an adaptive 32–100 ms Markdown interval. Follow-scroll runs after an actual paint. Hidden Code and minimized windows stop transcript painting while the engine continues, and wake catches up from current state. The native minimized-window test held the bubble at 3,024 characters while the model completed, then restored the final 27,029-character answer with no streaming caret left behind. A separate four-Terra-chat test checks native minimize and restore during real account generation.

Local-generation looping animations advance at 30 Hz instead of 20 Hz. Animation discovery uses `animationstart` and a wake rescan instead of observing every Markdown subtree mutation. Real local-model GPU throughput was not measured, so this test does not establish the effect of that animation change on local tokens per second.

The tray caches model inventory for 30 seconds, coalesces reads, filters providers by actual load/unload capability before fetching catalogs, and invalidates on model/provider changes. Explicit unload and cancellable reads remain fresh. Shared-chat publications now share a scheduler and bounded HTTP batches, avoid repeated unchanged-history serialization, and retain per-chat ordering and acknowledgements. Each server frame still receives host, lease, and workspace validation; a stale frame cannot reject another chat's successful terminal frame.

The smoother prose cadence has a cost. In the eight-second four-chat prose workload, renderer task time rose from 1,693 ms to 1,795 ms (6%), with zero long tasks in both. The fastest deterministic stream rose from 2,209 ms to 2,802 ms (27%), also with zero long tasks. The history and navigation improvements are substantial; these results do not show a universal reduction in CPU, heap, network bytes, or generation latency. Fewer HTTP requests do not imply proportionally fewer bytes.

Measurements use the same Apple M5 Max, 120 Hz display, synthetic streams/tools, and three isolated history replays as the [original review](minnow-performance-review-2026-10-30.md). The replays contain 536, 284, and 178 entries, with 6.7–8.0 MB payloads. The existing unrelated one-core background worker was left running. CDP frame intervals measure scheduling gaps, rather than compositor dropped frames. CPU throttling is an artificial sensitivity test. Production runs use the built frontend through the shipped server-host stack in an Electron BrowserWindow without the native tray; tray and native lifecycle checks use the actual development Electron shell. Stale-asset harness attempts after rebuilding were discarded and rerun after restarting the isolated browser/server. The account prompts contain synthetic material only.

The [machine-readable results](minnow-performance-improvements-2026-10-30-results.json) retain all measured cases, including controls and regressions. Local reproduction scripts and CPU profiles are under `.minnow/performance-fixes-2026-10-30/`; private history payloads and scratch homes are excluded. These probes are workstation-specific, rather than a new supported CI performance lane.

All five real `gpt-6.1-terra` UI runs completed without turn errors or tool calls. The single run took 59.1 seconds; the four concurrent runs took 54.8–63.8 seconds and produced 26,224–29,333 assistant characters each. The four-chat native wake check confirmed the window entered its hidden state and resumed visible output. The two-sample generation-adapter benchmark also completed all cold, warm, tool-request, and tool-result scenarios. Cold prose first text was 2.86–2.93 seconds; warm first text was 1.22–2.02 seconds. These provider-dependent times do not establish a generation-speed improvement.

Final validation passed: production build and TypeScript checking; 153 focused UI/chat/boot/session tests; 16 paging and embedded-view tests after the final anchor adjustment; seven incremental-Markdown tests; 95 remote tests; 105 chat tests; and 13 product-wiki tests. Groups overlap and should not be summed. Discovery found 1,868 files, with 1,865 in the full runner and three explicit exclusions. The complete repository suite was not run. Use the repository runner flags, including `--test-force-exit`; an initial manual run without it remained open, and the rerun with the repository flags passed. Visual checking also caught smooth CSS scroll behavior affecting programmatic page correction: the correction now applies instantly and restores the host preference, with a regression test and a repeated requested-page profile. The production navigation/history measurements do not invoke this correction and were unaffected.

All bundle budgets pass. Total assets are 11,982.6 KB, compared with 11,977.9 KB before and a 12,000 KB ceiling. The eager graph is still large; these fixes address interactive work rather than reducing the shipped graph. No budget was raised.
