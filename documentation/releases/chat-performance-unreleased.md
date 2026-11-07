# Chat performance implementation notes — unreleased

Supported ordinary conversations execute through the existing server host. Complete historical-workflow and packaged cross-platform certification is still outstanding; native coding remains unavailable until its admission/recovery bridge is certified.

- Plugin catalogs refresh by revision rather than every model round, with shared reads, explicit retry and live revocation checks.
- Optional memory/code-map preparation has a total deadline, including cold initialization. Required document failures stop dispatch with an actionable error.
- Managed metadata saves omit canonical transcript/run bodies, acknowledge changed entities independently and retain conflict recovery. Synthetic 10–2500-message fixtures produce the same metadata payload size.
- Git snapshots operate only on a copied index, preserving real index bytes and staged/unstaged separation, including split/unborn indexes.
- Server executions overlap baseline capture with provider work, then settle fresh pre/post snapshots at exclusive mutation boundaries. Interrupted effects retain explicit recovery evidence, including through archive restore.
- Managed sends preserve validated skill and issue/code-map context. Deferred worktree setup runs on the server before inference; Retry/Back to Local keep retained checkouts and never repeat the failed model turn automatically.
- Timing diagnostics distinguish request/output, preparation, external/host/human waits, DOM presentation and transcript durability. Component measurements are not end-to-end speedup claims.
- Modern canonical root conversations support revision-checked configuration and replay into a new branch, without executing historical tool calls to reconstruct it. Unsupported histories remain guarded.
- CLI settings validate/save before closing idle connections; active, waiting and settling connections keep their checkpoint homes. Concurrent Codex checkpoint reads coalesce while preserving full verification.

New and idle supported roots promote after a durable revision-checked flush, without taking over a live renderer lease. Completed historical call/result groups remain observational. `MINNOW_ORDINARY_CHAT_EXECUTION=0` disables new promotions while canonical chats keep server ownership and recovery.

**Not enabled:** Codex native coding actions. No inert native switch is exposed. Installed Windows native probes demonstrate that protocol-only readOnly is not an OS write boundary; scoped MXC profiles enforce the tested restrictions but still need trusted host admission/recovery integration. Full packaged Windows/macOS/Linux and renderer responsiveness certification is outstanding; the full repository test suite is not green.

Evidence: [overall](../plans/chat-performance-implementation-evidence.md), [session saves](../plans/chat-performance-session-save-evidence.md), [native capability matrix](../plans/chat-performance-native-report.md), [migration parity](../contributor/chat-server-execution-rollout.md).
