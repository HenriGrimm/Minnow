# Chat performance implementation notes — unreleased

Supported ordinary conversations execute through the existing server host. Codex native coding has a default-off experiment for the verified Windows Codex 0.166.0 / gpt-5.5 configuration. Complete historical-workflow and packaged cross-platform certification remains outstanding.

- Plugin catalogs refresh by revision rather than every model round, with shared reads, explicit retry and live revocation checks.
- Optional memory/code-map preparation has a total deadline, including cold initialization. Required document failures stop dispatch with an actionable error.
- Managed metadata saves omit canonical transcript/run bodies, acknowledge changed entities independently and retain conflict recovery. Synthetic 10–2500-message fixtures produce the same metadata payload size.
- Git snapshots operate only on a copied index, preserving real index bytes and staged/unstaged separation, including split/unborn indexes.
- Ordinary tool execution shares its first fresh pre-effect snapshot with the baseline under one checkout lock. Read-only turns take no Git snapshot. Each later mutation still settles fresh pre/post snapshots; native turns finish an eager baseline before starting. Interrupted effects retain explicit recovery evidence, including through archive restore.
- Managed sends preserve validated skill and issue/code-map context. Deferred worktree setup runs on the server before inference; Retry/Back to Local keep retained checkouts and never repeat the failed model turn automatically.
- Timing diagnostics distinguish request/output, preparation, external/host/human waits, DOM presentation and transcript durability. Component measurements are not end-to-end speedup claims.
- Modern canonical root conversations support revision-checked configuration and replay into a new branch, without executing historical tool calls to reconstruct it. Unsupported histories remain guarded.
- CLI settings validate/save before closing idle connections; active, waiting and settling connections keep their checkpoint homes. Concurrent Codex checkpoint reads coalesce while preserving full verification.

New and idle supported roots promote after a durable revision-checked flush, without taking over a live renderer lease. Completed historical call/result groups remain observational. `MINNOW_ORDINARY_CHAT_EXECUTION=0` disables new promotions while canonical chats keep server ownership and recovery.

**Native experiment:** the Models → CLIs switch captures the choice for future submissions. The private server authority fences admission, OS scope, action observations, handoffs and recovery. Native network access and escalation stay off; unsupported policies fail explicitly. Provider or permission edits can stop an active native turn for recovery. Other platforms, CLI versions and models remain unavailable for native execution.

Failed server turns retain a bounded, redacted diagnostic beside the composer after reload. Fresh profiles include their starter chat in the first session save. Compatibility renderer turns retain their tool-argument indicator when remounted.

Evidence: [current validation](../plans/chat-performance-production-validation.md), [implementation history](../plans/chat-performance-implementation-evidence.md), [session saves](../plans/chat-performance-session-save-evidence.md), [native capability history](../plans/chat-performance-native-report.md), [migration parity](../contributor/chat-server-execution-rollout.md).
