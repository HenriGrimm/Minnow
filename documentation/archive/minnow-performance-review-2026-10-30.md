# Minnow runtime performance evaluation October 30 2026

Minnow’s uneven feel comes from several costs that overlap: transcript backfill forces layout after the initial paint, app restoration rebuilds that transcript, streamed prose updates at about 10 Hz, and concurrent chats add transport and activity work. The strongest causal result is the history-backfill experiment: under a controlled 4× CPU slowdown, omitting older rows reduced the 95th-percentile frame gap from **58.2 ms to 9.3 ms**.

The application can also be smooth. Fully warmed production navigation had a 9.1 ms frame-gap p95 and no long tasks; native window focusing remained fast with four streaming chats. This is a problem with transient work, presentation cadence and available processing headroom, rather than evidence that every interaction is slow.

This evaluation changed no product code. Measurements are in [the accompanying JSON](minnow-performance-review-2026-10-30-results.json). CPU profiles and the one-off audit scripts are retained locally under `.minnow/performance-audit-2026-10-30/` and are gitignored. They contain no replayed conversation bodies. Original saved chats were read without modification; replay and inference used disposable Minnow homes.

## Test conditions and coverage

- Apple M5 Max, 18 logical CPUs, 128 GiB RAM; Node 24.18.0. Idle animation-frame intervals were approximately 8.3 ms.
- Actual Minnow Electron main/preload with Vite for source-level CPU profiles, native window tests, streaming and tool execution.
- Production `dist/`, served through the shipped `server-host` HTTP stack in a separate Node process and displayed in an Electron BrowserWindow. This window had workspace context but no native tray bridge. Production results independently reproduce the history sensitivity; native-shell behavior was measured in the development shell.
- CDP CPU sampling and `Performance.getMetrics`, a long-task observer, animation-frame intervals, timed foreground transitions, prose DOM mutations and request counts. Frame gaps describe renderer scheduling, not a compositor dropped-frame counter. An isolated long frame can include profiler setup overhead; sustained distributions and controlled comparisons carry more weight.
- Released app navigation, Source Control, read-only editor opens, native window focus, synthetic histories of 20/200/1,000 rows, sidebar populations of 50/200/500 chats, and three large saved-history replays.
- One and four concurrent prose streams, normal and accelerated deterministic delivery, background app rendering, and one/four tool-heavy chats. Each tool-heavy chat executed 40 actual, read-only `read_file` calls in eight batches.
- Real `gpt-6.1-terra` through Minnow’s installed Codex CLI adapter: two cold/warm/tool trials, plus one long UI chat and four concurrent long UI chats. All five UI turns completed without errors.

The live profile contained **1,053 chats and 56,038 messages**; its largest chat had 803 messages. Replay samples held 536, 284 and 178 messages, with serialized payloads of 7.97, 7.62 and 6.66 MB. All tool calls in the replay samples had recorded results. The largest individual tool result in the profile contained approximately 1.22 million characters. These sizes explain why short prose-only fixtures are insufficient.

An unrelated Vitest worker was already using roughly one CPU core and 4.8 GiB of resident memory after six days of runtime. It was left unchanged. Measurements represent this workstation’s existing environment. The 4× throttle tests are artificial CPU sensitivity tests; they do **not** measure local-model GPU contention, memory pressure or packaged-app performance on another machine.

The installed `/Applications/Minnow.app` binary was not launched or profiled. This evaluation covers the current checkout and its freshly built production assets.

## Principal measurements

| Scenario | Measurement | Interpretation |
| --- | --- | --- |
| Development boot | App ready 700 ms; interactive 845 ms | Startup is usable on this machine |
| Production replay boot | App ready 1,086 ms; interactive 1,288 ms | Different active history/cache state; not a direct dev-versus-production comparison |
| First production app-navigation matrix | Frame-gap p95 33.2 ms; max 166.4 ms; six long tasks, max 117 ms | Visible stalls occur without artificial slowdown while lazy/restoration work is active |
| Fully warmed production app matrix | Frame-gap p95 9.1 ms; zero long tasks | Steady state can be smooth |
| Settled production return to Code, 536-row replay | 61–69 ms, four returns | Restoration cost grows with transcript size |
| Settled production return to Code, 178-row replay | 48–55 ms, four returns | Lighter transcript is cheaper |
| Native window focus while four chats stream | Return to Code window 12–17.4 ms; zero long tasks | Native focusing was healthy in this test |
| Production history switches, 4× CPU slowdown | Frame-gap p95 32.3 ms; max 175.3 ms; 14 long tasks | The history issue survives production bundling |
| One versus four normal deterministic prose streams | Frame-gap p95 9.9 versus 10.1 ms; zero long tasks in either case | Four prose streams alone did not reproduce a major frame-rate collapse |
| Read-only editor opens | 31–53 ms in the tested development session | No large stall observed for these files |
| Repeated sidebar render with 500 chats | Approximately 0.5–0.8 ms synchronous work | Sidebar row count alone was not the dominant cost |

The first production matrix and fully warmed matrix differ in active transcript and outstanding lazy/backfill work. The separate settled 536-row/178-row return tests isolate transcript size more closely. Production history `1x` raw `firstPaintMs` can include a loading placeholder; use its completed row counts and frame distribution, not that number as a transcript-ready latency.

## History backfill is the largest confirmed interaction cost

[`messages.ts`](../../src/ui/messages.ts) initially paints the last 30 history entries, then automatically fills the older history in chunks of up to 15 entries or 6 ms of construction work. This protects the first paint, but eventually mounts the whole transcript.

The chunk budget stops before insertion and layout. `prependPreservingScroll()` reads scroll geometry, prepends the chunk and immediately reads the new `scrollHeight`. That second read forces the browser to resolve the styles and layout invalidated by insertion. Repeating this as the document grows is substantially more expensive than the detached-node construction time suggests. The work-view observer in [`chat-work.ts`](../../src/ui/chat-work.ts) also regroups mounted rows after structural changes.

Source-level sampling in the 4× replay test attributed approximately **2.13 seconds** inclusively to `prependPreservingScroll()` across three history switches. These are sampled inclusive times, so they must not be added to overlapping parent functions.

A controlled experiment intercepted only the history backfill scheduler in memory. Both variants started from the same short chat and switched through the same saved-history samples at 4× slowdown. The experimental variant retained only the recent transcript; it is evidence for reducing eager history work, not a complete implementation of history navigation.

| Three switches | Existing backfill | Recent rows only |
| --- | ---: | ---: |
| Frame-gap p95 | 58.2 ms | 9.3 ms |
| Frames with gap above 33.4 ms | 50 | 7 |
| Long tasks | 12 | 3 |
| Total long-task time | 967 ms | 191 ms |
| Layout plus style recalculation | 2,534 ms | 232 ms |
| Renderer task time | 5,682 ms | 1,652 ms |
| Mounted document nodes at measurement end | 21,626 | 4,184 |

Layout/style work fell approximately **91%**, and renderer task time fell approximately **71%**. Remaining setup/activation outliers mean the maximum frame gap alone does not describe the improvement.

**Recommended first change:** mount older turns on demand or virtualize the transcript. Preserve the scroll anchor without forcing a complete layout after every small prepend. Include attachment, style and layout cost in the scheduling budget, rather than budgeting only row construction. Keep tool bodies and historical disclosures cheap until opened. Verify scroll stability, disclosure state, live-stream remounting and message indices with the existing transcript contracts.

## Returning to Code repeats restoration work

[`app-host.ts`](../../src/os/app-host.ts) awaits Code restoration before revealing its layer. [`restoreCodeSessionOnForeground()`](../../src/os/code-launch.ts) calls `refreshCodeChatSurface()` even when the active chat already belongs to the current workspace. That refresh rebuilds the transcript, reinstalls work/scroll controllers, synchronizes composer widgets and forces file-panel synchronization.

The settled production tests were reasonably quick, but this work repeats on every return and restarts backfill. During initial mixed app navigation, Code activation ranged from 229–258 ms. Fully settled returns were 61–69 ms for the heavier replay. Development-shell returns were commonly around 180–270 ms, so development measurements should not be presented as packaged steady-state latency.

**Recommended change:** preserve the mounted view when the active chat and transcript revision have not changed. Refresh necessary metadata independently, and refresh the file panel only when its workspace or checkout changes. Use a bounded cache or virtualization so avoiding reconstruction does not retain an unbounded DOM for every chat. Keep execution, session ownership and stream remount behavior independent of view caching.

## Smooth frames still carry visibly stepped output

[`ASSISTANT_RENDER_DEBOUNCE_MS`](../../src/constants.ts) is 100 ms. In an eight-second normal streaming sample, the selected assistant bubble updated **77 times**, with a median gap of **104.8 ms** and p95 **107.2 ms**. The same sample’s frame-gap p95 was only 9.2 ms. The renderer was keeping up with display frames while the visible text advanced in roughly ten updates per second.

There is also an intentional local-inference animation policy. [`motion-ticker.ts`](../../src/ui/motion-ticker.ts) pauses infinite CSS animations and advances them at **20 Hz**. [`run-turn-chat.ts`](../../src/chat/run-turn-chat.ts) acquires this policy for local providers; CLI/cloud turns are excluded. The composer wave has its own 30 Hz limit. A local-provider chat can therefore look less fluid even without a long JavaScript task. The inference-throughput benefit of these limits was not measured in this evaluation.

Meanwhile, [`run-turn-chat-paint.ts`](../../src/chat/run-turn-chat-paint.ts) requests follow-scroll on coalesced stream updates even when Markdown’s 100 ms throttle has deferred the actual DOM change. The Markdown timer and resize observer can request scrolling again. [`scrollChatIfPinned()`](../../src/ui/chat-scroll.ts) reads scroll/layout geometry. A normal stream profile sampled approximately 647 ms inclusively in this function over ten seconds.

**Recommended change:** coordinate text presentation and scrolling around actual DOM changes, with one layout-read/write pass per relevant frame. Experiment with a cheaper, more frequent text path while deferring expensive Markdown work. Simply reducing the 100 ms constant would increase parsing and layout pressure: [`renderer.ts`](../../src/markdown/renderer.ts) still lexes the entire growing response. Make the local animation tradeoff adaptive or configurable and measure both responsiveness and inference throughput before changing its default.

## Concurrent chats add work beyond visible text

The normal deterministic test increased renderer task time only modestly, from 1.95 seconds for one chat to 2.07 seconds for four over ten seconds. This is consistent with background chat DOM suppression limiting rendering work. The additional costs below still reduce headroom when histories, tools, local inference or other windows are active.

### Shared chat publishing scales per chat

[`shared-chat-bridge.ts`](../../src/chat/shared-chat-bridge.ts) schedules publications per chat at 40 ms and sends them through an HTTP POST. Four normal streams generated **693 publish requests in eight seconds**, approximately **87 requests/second**, despite there being no remote viewer. Request bodies totaled approximately 532 KB. The wire protocol already uses incremental text appends; the problem is request frequency and repeated local serialization, not transmission of the whole response on every update.

Each publication also serializes the current-turn message suffix and cumulative live text for comparison. The sampled four-fast-stream profile attributed approximately 149 ms over ten seconds to publishing. This was measurable overhead, but did not by itself cause a frame-rate collapse on this machine.

**Recommended change:** batch chat publications across chats, or use the existing shared WebSocket infrastructure. Consider observer-aware publication while preserving immediate commands, ownership, reconnect snapshots and durable saved state. Avoid rebuilding cumulative comparison strings when an incremental version or offset suffices.

### Invisible chat surfaces still process Markdown

[`isStreamDomVisible()`](../../src/chat/streaming-state.ts) can return true for the selected ordinary chat after Code has ceased to be the foreground app. In the Settings-foreground stress sample, the transcript surface had no visible text, but CPU sampling still recorded approximately **336 ms in incremental Markdown rendering**, **320 ms in follow-scroll**, and **190 ms in animation discovery** over ten seconds. Those are overlapping inclusive samples, not additive totals.

**Recommended change:** gate presentation work on the actual mounted/visible surface and render-idle state. Continue inference, tool execution, leases, snapshots and persistence; repaint the latest state when the surface becomes visible. Preserve embedded Code, Dashboard, Issues and board conversation hosts when deciding visibility.

### Tray status repeatedly fetches model catalogs during tool activity

[`electron-tray-bridge.ts`](../../src/electron-tray-bridge.ts) subscribes to turn, sub-agent, title and managed-chat activity. It throttles status refreshes to 400 ms, but `buildTrayStatus()` refreshes model inventory before comparing the resulting tray snapshot with the previous one. [`collectLocalModelTraySnapshot()`](../../src/providers/local-model-tray.ts) queries every enabled provider, then filters the results to locally controllable models.

In the four-chat tool test, the enabled tray bridge made **44 provider-catalog requests** over approximately 8.85 seconds: eleven requests to each of four providers, including Codex CLI. Disabling just the tray bridge in memory removed all provider-catalog requests in the repeated workload. Serve-list requests fell from sixteen to four.

Pure prose did not produce this catalog burst. Frame-gap p95 was approximately 9.2–9.3 ms with or without the bridge; these trials do not establish a frame-rate improvement from removing it. They do establish avoidable activity-driven network/server work.

**Recommended change:** cache model inventory separately from agent counts, refresh it on relevant model/provider events or a slow bounded fallback, and exclude providers that cannot contribute unloadable local models before fetching their catalogs. Coalesce in-flight refreshes. Apply the same cache across native windows where practical.

## Model latency and healthy paths

The existing account benchmark exercised production Codex adapters using `gpt-6.1-terra`, low reasoning effort and synthetic prompts:

| Scenario | First visible output, two samples | Completion, two samples |
| --- | --- | --- |
| Cold short prose | 3,164 / 2,318 ms | 3,600 / 2,998 ms |
| Warm short prose | 1,196 / 1,151 ms | 1,451 / 1,491 ms |
| Tool request | 1,297 / 1,519 ms | 1,299 / 1,520 ms |
| Tool-result continuation | 905 / 944 ms | 1,003 / 1,083 ms |

Measured prose output gaps in those short adapter trials were at most 74 ms. These timings end at the local stream subscriber and exclude browser paint. They separate account/model waiting from the renderer issues above. The long UI chat completed in 55.6 seconds; four concurrent UI chats completed in 54.8–66.2 seconds. Those five runs establish that the requested real CLI path worked concurrently, not a controlled comparison of model throughput.

Native window focusing was fast both idle and during four deterministic streams. The 500-chat sidebar rendering test and the SQLite performance suite also passed. The database suite covers 500 chats with 200 messages each and asserts a narrow-lookup median below 5 ms and whole-state reconstruction below 500 ms. These results do not point to SQLite lookup latency or native focus as the primary issue.

## Build checks and regression coverage

`npm run build` succeeded, including TypeScript checking. All bundle budgets passed:

| Metric | Measured KB | Budget KB |
| --- | ---: | ---: |
| Entry JavaScript | 364.8 | 1,500 |
| Entry CSS | 790.3 | 950 |
| Largest lazy JavaScript | 3,381.8 | 3,900 |
| Eager JavaScript, 100 chunks | 4,558.3 | 4,800 |
| Total assets | 11,977.9 | 12,000 |

The eager graph remains large, but bundle ceilings do not measure interactive smoothness. The CI boot harness checks loader signaling with happy-dom, rather than launching and navigating the complete app. Existing Markdown tests validate rendering and throttling correctness; a ten-Hz stream can pass them.

Targeted checks passed: **13 boot/motion tests, seven incremental-Markdown tests and two SQLite performance tests**. Test discovery also passed for 1,865 files. Use the repository’s `--experimental-test-module-mocks` runner configuration for the Markdown suite; the initial invocation without that configuration did not finish cleanly. The full functional suite was not run for this audit.

## Recommended implementation order and acceptance checks

1. **Bound history DOM and remove forced layout from each backfill chunk.** Re-run the large saved-history workload and a synthetic tool-heavy equivalent, including under 4× slowdown. Verify scroll anchoring, disclosures, absolute indices and streaming remounts. Target a sustained frame-gap p95 below 16.7 ms during navigation on the evaluation machine under the same throttle.
2. **Preserve unchanged Code presentation across app switches.** Measure activation separately from background history completion. Keep warmed returns below 100 ms with large transcripts and avoid rebuilding the same history merely because another app was opened.
3. **Unify stream presentation and follow-scroll scheduling.** Track visible text-update cadence separately from animation-frame gaps. Improve cadence without increasing full-response lexing, layout or hidden-surface work. Verify actual local-model tokens/second alongside animation smoothness.
4. **Remove repeated tray catalogs and batch live publications.** Assert no provider-catalog fan-out from ordinary tool-phase changes. Add request-rate and serialization measurements for one/four/eight chats, with and without remote observers and additional native windows.
5. **Add a real-browser performance lane.** Cover initially loaded and fully warmed apps, long tool histories, concurrent streams, native focus/wake and constrained CPU. Retain profiles for regressions; separate first usable transcript, complete history, input-to-next-paint and visible text-update cadence. Keep database and bundle gates as complementary checks.

The account benchmark is independently repeatable:

```sh
MINNOW_HOME=/path/to/scratch-home node scripts/benchmark-chat-latency.mjs \
  --account --samples 2 \
  --targets '[{"providerId":"codex-cli","model":"gpt-6.1-terra","kind":"codex"}]' \
  --output /tmp/minnow-terra-latency.json
```

This spends account inference. UI audit scripts in the local artifact directory are workstation-specific probes, not a supported test runner. The replayed private histories are intentionally excluded from the deliverable; the JSON retains only sizes, counts and measurements.
