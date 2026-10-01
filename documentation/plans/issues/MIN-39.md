# MIN-39: Preserve completed orchestrator durations

1. Retain journal start and end timestamps outside the pure board fold, including snapshot hydration after reload.
2. Keep completed agent durations visible beside outcomes in the Work list and transcript header. Show total recorded agent time on inactive task cards, including retries in the current run.
3. Keep completed clocks static; only running clocks carry ticker attributes. Omit timing when old journal entries lack timestamps.
4. Verify live completion and reload through client tests, plus completed card/detail rendering, retries, retired work, and missing timing through focused UI tests.

Completed: journal timing sidecars cover agents and synthetic merge attempts; completed cards show current-run agent time, while Work and transcript headers retain individual attempt durations, including retired work. Completed clocks omit the live ticker attribute.

Validation passed: `node --import tsx --import ./test/test-loader.mjs --test --test-force-exit test/orchestrator/client.test.mts test/ui/orchestrator-boards-kanban.test.mts` and `npx tsc --noEmit`. The test runner's force-exit option closes background handles retained by UI imports after assertions finish.
