# CLI account usage

## Scope and implementation plan

Show Codex and Claude subscription allowance inside Minnow, separately from
per-turn tokens and cost. Reuse the CLI provider configuration and login stores.

1. Add a read-only `GET /api/models/agent-clis/:kind/usage` endpoint with an
   optional `refresh=1` query. Normalize quota windows, reset times, plan and
   optional credits. Return explicit unavailable, signed-out and error states.
2. Query Codex `account/read` and `account/rateLimits/read` through the existing
   bounded app-server RPC in a private temporary home. No threads or inference.
   Reuse the guarded credential-refresh synchronization and clean up processes.
3. Isolate Claude's undocumented `/api/oauth/usage` endpoint in its own adapter.
   Use file-backed OAuth login, an OAuth environment token, or macOS Keychain.
   API-key configurations do not imply subscription usage. Never return tokens,
   credential paths, account email, raw responses or provider error bodies.
4. Share an account-keyed in-memory cache with coalesced requests, a one-minute
   success TTL, failure backoff, and at most one hour of labeled last-known data.
   Refresh respects backoff. Credentials changing during a read discard it.
5. Add quota details to Models → CLIs and a compact allowance button beside the
   selected CLI model in Code. Reuse one view for labels, reset times, refresh,
   loading, stale and unavailable states. Pause polling when the view is hidden.
6. Test protocol isolation, normalization, credentials, cache/backoff and UI
   lifecycle; run the agent-CLI suite, type check, production build and budgets.
   Update architecture and shipped user documentation.

## Design decisions

- Keep all provider windows; never assume every account has a five-hour window.
- Show remaining percentage and the exact reset time in the user's locale.
- A missing measurement is unavailable, never zero usage.
- Quotas are account-wide, including usage outside Minnow.
- No billing changes, credit purchases, logout or model calls from this feature.
- Cursor reads the private RPCs behind the CLI's `/usage` command with the CLI's own login.

## Sources and verified feasibility

- [Codex app-server](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt):
  documented account quota RPC; verified locally with CLI 0.153.4.
- [Claude status-line quota fields](https://code.claude.com/docs/en/statusline#rate-limit-usage):
  five-hour and weekly usage. The installed CLI 2.1.226 uses the private OAuth
  endpoint, verified locally with an authenticated GET and no inference.

## Completed validation

- Both production adapters returned live account quota without inference.
- Agent CLI regression suite and focused composer/CLI panel tests pass, including
  normalization, refresh/backoff, account changes during success or failure,
  credential redaction, protocol isolation, and renderer teardown.
- Browser checks pass for popover opening, Escape/focus restoration, dark/light
  themes, and a 390px layout with no horizontal overflow.
- Production build (including TypeScript), test discovery coverage, product wiki
  tests, new-component design checks, and all bundle budgets pass.
- Claude's endpoint remains a private vendor contract isolated behind its adapter;
  vendor changes return unavailable/error states without inventing allowance.
