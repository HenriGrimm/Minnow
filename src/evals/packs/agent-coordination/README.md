# Agent coordination behavioral eval

This pack uses the existing eval runner and grader with explicit scripted tool responses. It never creates chats, sends messages, changes settings, stops work, or falls back to a real tool executor. Model inference and grading still use the selected eval providers when a suite is explicitly run.

The twelve cases cover requested agent counts and model options, unavailable targets, unsupported effort, asynchronous delegation without polling, existing-child follow-ups, fresh reviews, existing-chat messaging, pinned turn Stop, wait timeouts, policy denial, recorded child results, and simple answers without tools.

Each step checks the tool name and expected argument fields. Nested expected values match exactly. Extra top-level schema arguments such as a retry key are permitted. Unscripted calls and missing steps fail the deterministic tool contract even if a prose grader would accept the answer. Real tool definitions and the shared prompt composer are reused; no second chat loop is introduced.

## Evidence

Real-model runs: **NOT RUN**. No model endpoint, account inference, grader inference, cost, latency, or model pass rate is claimed by the deterministic tests. The skipped real-model test records this separately. The tests validate pack/schema parity, fixture isolation, ordered argument contracts, and rejection of prose-only success claims.

When explicitly running a model matrix later, keep the fixture label and saved `fixtureReport` with the grader results. These measure model choices against simulated responses; production authority, persistence, concurrency and cancellation are verified separately by the chat integration suites.
