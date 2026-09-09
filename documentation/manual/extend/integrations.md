# Integrations

Ways to give Minnow capabilities it does not ship with, and to connect it to things outside itself. All of these live under **Settings → Integrations**.

## MCP servers

The Model Context Protocol is a standard for exposing tools to an AI client. Any MCP server you add contributes its tools to Minnow, named `mcp__<server>__<tool>`.

**Context7** ships enabled by default. It fetches up-to-date documentation for libraries, which is the fix for a model confidently using an API that changed two versions ago. It works without a key; adding one raises your rate limits.

Add your own under **Settings → Integrations → MCP servers**.

**MCP tools bypass the mode allowlist.** They are governed only by your permission settings, which means a mode that carefully excludes shell access does not exclude an MCP server that can run commands. Treat adding one like installing a browser extension: look at what it can do before granting Full.

## Language servers

Real language intelligence in the Code editor: diagnostics, hover, signature help, go to definition, workspace symbols.

Enabled by default and bundled: **TypeScript/JavaScript**, **Pyright**, **HTML**, **CSS**, **GraphQL**, **YAML**, **Bash**, **Dockerfile**.

Available but off until you enable them, because they need the toolchain installed: **Rust Analyzer**, **gopls**, **clangd**, **Lua**, **Terraform**, **Zig**.

Configure under **Settings → Integrations → Language servers**. The agent gets `get_lsp_diagnostics`, so "fix the type errors" can be grounded in what the language server actually reports rather than what the model guesses. On a board with worktree isolation, language servers are started per checkout so diagnostics match the code that task is editing.

## Browser automation

Minnow has a real Chromium browser view, and the `browser_*` tools drive it: navigate, click, fill, snapshot, screenshot, evaluate, and manage tabs.

This is what lets an agent log into a site, walk through a form, or screenshot the interface it just built. It needs the Electron desktop app; the tools do not exist in a plain browser tab.

**Settings → Integrations → Browser**:

| Setting | Default |
|---------|---------|
| Allow navigation | On |
| Allowed origin patterns | `http://localhost:*`, `http://127.0.0.1:*`, `https://localhost:*` |
| Restore tabs | On |
| DevTools dock | Bottom |

The allowlist starts at localhost only. Anything else has to be added, or approved when the agent asks. That is the boundary that keeps "take a screenshot of my dev server" from becoming "browse the whole internet on my behalf while logged into my accounts".

The `/browser-automation` skill has the recipes.

## Web search

**Settings → Integrations → Search** sets the provider for `web_search` and for the Research engine.

| Provider | Needs |
|----------|-------|
| **SearXNG** | Nothing — Minnow provisions and runs it locally on port 8899, including its own Python. The default. |
| **DuckDuckGo** | Nothing |
| **Brave** | API key |
| **Tavily** | API key |

A fallback chain — Tavily, Brave, DuckDuckGo — covers the primary failing. Result count and API keys are set here.

**Settings → Integrations → Servers** manages the local processes Minnow runs for you: SearXNG (auto-starts) and `llama-cpp` (on demand). Enable, auto-start and port for each.

## Dev servers

Registered per project and managed from the Code app's dev-server screen: command, working directory, port, auto-start, and which git worktree to run in. Logs and listening ports in one view.

The `manage_dev_servers` tool gives the model the same controls — list, create, update, delete, start, stop, restart. See [Code](../apps/code.md).

## Webhooks

**Settings → Integrations → External** sends HTTP POSTs when things happen in Minnow.

Subscribable events:

| Event | Fires when |
|-------|------------|
| `chat.completed` | A chat turn finishes |
| `session.created` | A new session starts |
| `scheduler.job_completed` | A scheduled job finishes |

Deliveries are HMAC-signed so your receiver can verify them, time out after 10 seconds, and retry three times with backoff. Outgoing URLs are checked against SSRF — you cannot point a webhook at internal network addresses.

Useful for wiring a scheduled job's result into Slack, or logging completions somewhere central.

## Native plugins

Tool plugins register as `plugin__<tool>`. Like MCP, they bypass the mode allowlist and are governed by your permission settings. Authoring guide: the plugin documentation in the repository.

## Document handling

Reading and writing PDF, Word and Excel is built in rather than an integration, but it is worth knowing it exists:

- `read_document` extracts text from PDFs and office files, either from disk or from a composer attachment.
- `create_pdf`, `create_spreadsheet` and `create_word_document` write real binary files. PDF text uses subsetted fonts covering Latin, Cyrillic, Greek, CJK and emoji.
- The file viewer previews PDFs inline and renders spreadsheets and Word documents as sanitized HTML in a locked-down sandbox.

## Related

- [Tools and permissions](../concepts/tools-and-permissions.md)
- [Privacy and security](../reference/privacy-and-security.md)
- [Code app](../apps/code.md)
- [Settings app](../apps/settings.md)
