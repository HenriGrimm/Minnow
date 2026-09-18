# Agent CLI providers

Implementation plan and decisions for [#1175](https://github.com/HenriGrimm/Minnow/issues/1175).

## Contract

Claude Code, Codex, and Cursor use `agent-cli-v1` behind the existing provider registry and `/api/generations` transport. Each invocation receives the complete caller-owned transcript. The shared Minnow runner owns tools, permissions, questions, board reports, persistence, cancellation, and subsequent rounds. CLI credentials stay in the CLI's authentication store; scans and catalog discovery never make inference requests. Background and utility use requires explicit opt-in.

## Improvements to the issue plan

1. **Yield tool requests to the existing runner.** A direct MCP-to-`/api/tools` bridge bypasses renderer approvals and cannot execute browser-only tools. Instead, a generation-scoped stdio MCP server exposes the caller's exact tool catalog. The first tool request ends the CLI inference round with a normal OpenAI `tool_calls` response. The CLI process tree is stopped before the generation completes. Minnow executes the request once, then replays the resulting transcript for the next round. Report tools and questions retain their existing interception. No second tool execution path, activity endpoint, approval protocol, or synthetic transcript is needed.
2. **Keep replay as the only session mode.** The parent issue locks stateless replay; the optional resume phase conflicts with it and introduces divergent history after trimming, retries, branches, and tool rounds. Each invocation uses private scratch configuration and no persisted conversation.
3. **Isolate native tools and configuration.** Use supported per-CLI controls to disable native execution tools, hooks, and unrelated MCP servers. Never offer arbitrary arguments or permission bypass switches. Run in a private scratch directory, with only the Minnow MCP bridge available. Codex's three fixed MCP resource helpers remain in its catalog whenever any MCP server is present; the isolated Minnow server exposes no resources, so these cannot read files or execute actions. Configure approval of the handoff transport itself; Minnow still approves the requested action after the CLI exits.
4. **Use a narrow bridge credential.** The shim receives an ephemeral credential for one loopback listener and one generation, never the Minnow API token. It can submit one catalog-validated tool request and cannot execute tools. The listener, credential, process tree, and temporary files share one lifetime.
5. **Preserve useful context.** Replay drops private assistant reasoning, escapes transcript boundaries, and retains tool results. Oversized input fails with a useful error instead of silently truncating file contents. Claude images use native image content over stdin, avoiding disabled file-reading tools.
6. **Bound all lifecycle resources.** Apply per-provider FIFO concurrency, cancellation while queued, stdout idle and wall-clock timeouts, bounded JSONL records and diagnostics, and cleanup on spawn errors, malformed output, cancellation, and successful completion. Failover is allowed only before visible output or a tool handoff.
7. **Truthful discovery.** Installation, authentication, enabled state, and last verification are separate. Keyring-backed authentication may be unknown. Static catalogs and capabilities do not spend subscription usage. Sign-in and Install are explicit actions in Minnow's terminal. Cursor's installer is shell-aware: POSIX `curl | bash`, native Windows PowerShell `irm | iex`.
8. **Preserve compatible authentication.** Codex keys its OS credential store by its home directory, so an isolated home cannot reuse a keyring-only login. The explicit Sign in and Verify commands select Codex's supported `file` credential mode without changing the user's configuration. Isolated invocations copy the native `auth.json`, and refreshed credentials are written back only when the source has not changed since the copy. Claude retains its configured credential directory; each adapter passes only its own supported authentication environment variables.

## Work packages

- Provider platform: reserved provider ids; validation, persistence, inert HTTP paths, static catalog/capabilities, CLI detection and settings routes.
- CLI invocation: executable resolution, shell-free Windows/POSIX spawn, isolated configuration, supported effort controls, auth environment, Claude native images.
- Transport: bounded JSONL decoding, transcript conversion, per-CLI event translation, terminal error classification, SSE/non-streaming output, MCP handoff, admission and process lifetime.
- Interface: lazy Models → CLIs section, detection/authentication controls, enablement, explicit background-use setting, concurrency and Claude spend cap, accessible errors and responsive layout.
- Verification: executable fixtures, translator and protocol tests, no-double-execution and tool replay tests, cancellation/timeout/queue/cleanup tests, provider and UI contracts, typecheck, build, performance budgets, and available local CLI smoke checks.

## Source contracts

- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference/)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/)
- [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters)
- [Cursor CLI permissions](https://cursor.com/docs/cli/reference/permissions)

CLI protocols evolve independently of Minnow. Fixture coverage demonstrates transport behavior; live smoke checks record the specific installed versions and remain distinct from fixtures.

## Implementation verification

- `npm run test:agent-cli` exercises API validation and encrypted secrets, discovery, model metadata, settings and picker refresh, transcript replay, JSONL framing, real subprocesses, cancellation, bounded output, and authenticated MCP handoff.
- The shared-runner integration drives three CLI rounds: `ask_question`, a file tool executed exactly once, and `report_outcome`. It verifies normal tool events and preserves local question/report interception.
- `node test/fixtures/native-claude-mcp-smoke.mjs` verified Claude Code **2.1.226** against a local fake Anthropic endpoint. Its real tool catalog contains the supplied Minnow tool with native tools disabled; calling it reaches the production bridge.
- `node test/fixtures/native-codex-mcp-smoke.mjs` verified Codex CLI **0.153.4** against a local fake Responses endpoint. Its real namespaced Minnow call reaches the bridge. The test allows only that namespace and Codex's fixed, inert resource-discovery helpers.
- Native checks make no paid inference requests and do not modify account credentials. Cursor is not installed on the verification machine; its adapter is covered by executable protocol fixtures and the published parameter/permission contracts.
- The production build and bundle budgets pass. The CLIs panel was visually checked in dark and light themes at desktop and 390-pixel widths, including settings save and connection failure states.
- Final focused run: **69 passed**. Packaging validation, test discovery, the 13 product-wiki tests, and 15 headless tests also pass. Explicit `minnow run` requests carry the foreground role so background-use gating does not block them.
- Full regression run: **9,615 passed, six failed, one timed out, four skipped**. Three failures require Windows symlink privileges; three concern the existing `server/sub-agents/ws.js` purity/type-companion contract. The router queue timeout did not reproduce: its focused suite passed all nine tests. Those implementation and test files were not changed by this integration.

## Follow-up: Windows detection (Codex + Cursor)

- [x] Unwrap current npm `"%_prog%"` / `"%dp0%\…js"` command shims so Codex `.cmd` counts as installed
- [x] Resolve Cursor's PowerShell `.cmd` launcher to the newest `versions/*/node.exe` + `index.js`
- [x] Fall back to well-known install dirs when PATH (Electron) omits them
- [x] Tests for shim unwrap, Cursor version payload, and well-known discovery

## Follow-up: Cursor stdin and account catalog

- [x] Send the Cursor prompt on stdin (`--print` with no positional) instead of argv, removing the 24 KB Windows command-line cap
- [x] Trust the isolated scratch workspace in print mode (`--trust`)
- [x] Enrich the picker from `cursor-agent --list-models` (not inference) with a multi-model static fallback
- [x] Parse `--list-models` under Vite's `FORCE_COLOR` (colorless capture env + ANSI strip) so the picker is not stuck on the static headlines

## Follow-up: in-app Install

- [x] Replace copy-install commands with **Install** buttons that open Minnow Terminal
- [x] Run the vendor installer for the tab shell (Cursor PowerShell on Windows)
- [x] Update Models manual, context, and CLI panel tests

