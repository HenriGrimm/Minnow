# Integrations

Ways to give Minnow capabilities it does not ship with, and to connect it to things outside itself. All of these live under **Settings → Integrations**.

## MCP servers

The Model Context Protocol is a standard for exposing tools to an AI client. Any MCP server you add contributes its tools to Minnow, named `mcp__<server>__<tool>`.

**Context7** ships enabled by default. It fetches up-to-date documentation for libraries, which is the fix for a model confidently using an API that changed two versions ago. It works without a key; adding one raises your rate limits.

Under **Settings → Integrations → MCP servers**, paste a standard JSON configuration and choose **Add servers**:

```json
{
  "mcpServers": {
    "cloudflare-api": { "url": "https://mcp.cloudflare.com/mcp" },
    "linear": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]
    }
  }
}
```

You can also give this configuration to an agent and ask it to add the servers. Agents can use the new tools in the same task. Configurations can be saved directly in `~/.minnow/mcp.json` using the same `mcpServers` object; existing Minnow server configurations remain supported.

**Adding a server makes its tools available.** MCP calls follow the global permission mode across chats and agents. Disable or remove the server to stop access.

Minnow discovers tools when it connects and updates them when the server announces a change. It does not poll tool lists. For a server that does not announce changes, choose **Refresh tools** on its Settings row. A failed connection waits for **Refresh connection**, a configuration change, or completed sign-in before trying again.

Remote servers support Streamable HTTP and legacy SSE (`"type": "sse"`). Local servers accept `command`, `args`, `env`, and optional `cwd`; remote servers accept `url` and optional `headers`. Local commands must be installed and available on your PATH.

When a remote server requires OAuth, choose **Sign in** and complete the provider's login in your browser. Minnow handles discovery, dynamic client registration, PKCE, and token refresh, with tokens encrypted locally. Servers that need a registered client can include an `oauth` object with `clientId`, optional `clientSecret`, `scope`, or `clientMetadataUrl`. Service accounts can specify `grantType: "client_credentials"` in that object. Command-based bridges such as `mcp-remote` manage their own provider login and credential storage.

## Minnow as an MCP hub

To let another agent use Minnow's Issues and Brain through MCP, see [Connect other agents to Minnow](mcp-hub.md).

## Language servers

Real language intelligence in the Code editor: diagnostics, hover, signature help, go to definition, workspace symbols.

Enabled by default and bundled: **TypeScript/JavaScript**, **Pyright**, **HTML**, **CSS**, **GraphQL**, **YAML**, **Bash**, **Dockerfile**.

Available but off until you enable them, because they need the toolchain installed: **Rust Analyzer**, **gopls**, **clangd**, **Lua**, **Terraform**, **Zig**.

Configure under **Settings → Integrations → Language servers**. The agent gets `get_lsp_diagnostics`, so "fix the type errors" can be grounded in what the language server actually reports rather than what the model guesses. On a board with worktree isolation, language servers are started per checkout so diagnostics match the code that task is editing.

## Browser automation

Minnow has two browser surfaces. The visible preview uses Electron Chromium. The isolated **Agent Browser** can use a live desktop tab or a server-owned headless browser. The `browser_*` tools cover navigation, snapshots, clicks, fills, screenshots, evaluation, and tab management on either surface.

Use `surface: "agent"` for private work: call `browser_reserve_tab` first, keep the returned `tab_id`, and pass it explicitly to every later action. Agent `browser_list` shows only tabs owned by that run. Use `surface: "user"` only when you intentionally want the visible preview; list or create a tab, then pass its explicit `tab_id`. A tab id does not grant control over another agent's tab, and an agent should not navigate or close tabs it does not own. Release a finished agent tab for inspection or reassignment, or close it to release its browser resources.

For a live page inside the desktop viewer, enable **Settings → Integrations → Browser → Use native browser for new agent tabs**, then ask the agent to reserve a new tab. Open the viewer from the browser sidebar button. **Watch** shows the live page. **Take control** gives you native keyboard, pointer and clipboard input and pauses agent browser commands. **Watch** returns the same page and its signed-in session to the agent. Closing the viewer while you have control keeps the tab paused.

If sign-in redirects to a blocked identity provider, choose **Take control → Retry navigation** and review the destination in the desktop prompt. A user-initiated sign-in popup shares the tab’s isolated session. Complete or close it and return to the approved app before handing back control. Some identity providers require their own supported browser flow.

In **Guide**, select a page element, enter your note, and choose **Send to owner**. The viewer distinguishes a queued note from one received at the owning turn’s next boundary. A saved chat can receive a pending note for up to 24 hours. If the original tab closes, the note supplies context for the chat.

Each tab uses disposable storage. You can close one tab or clear all tabs. The service supports up to eight tabs. Headless sessions use an installed Chrome, Edge, Brave, or Chromium browser, optionally selected with `MINNOW_BROWSER_PATH`. An agent can request a screenshot while it owns the tab, including with the viewer closed.

Both surfaces use the browser navigation allowlist. Localhost is allowed by default. For a new external origin, use the structured `ask_question` flow and then `request_browser_origin_access` before retrying navigation; unattended Agent Browser work cannot approve its own blocked origin. The preview tools require the Electron desktop app, while Agent Browser actions are server-dispatched and need Minnow's local server.

**Settings → Integrations → Browser**:

| Setting | Default |
|---------|---------|
| Allow navigation | On |
| Use native browser for new agent tabs (desktop) | Off |
| Allowed origin patterns | `http://localhost:*`, `http://127.0.0.1:*`, `https://localhost:*` |
| Restore tabs | On |
| DevTools dock | Bottom |

The allowlist starts at localhost only. Anything else has to be added, or approved when the agent asks. The `restoreBrowserTabs` setting applies to the visible preview; Agent Browser sessions are disposable.

The `/browser-automation` skill has the recipes.

## Web search

**Settings → Integrations → Search** sets the provider for `web_search`.

| Provider | Needs |
|----------|-------|
| **Tavily** (default) | API key from a free account at [tavily.com](https://www.tavily.com/) |
| **SearXNG** | Optional local installation on port 8899, or an existing instance |
| **DuckDuckGo** | Nothing |
| **Brave** | API key |

Result count and API keys are set here. Tavily search accepts domain filters, relative date windows or explicit dates, result count (up to 20), topic, and search depth. Basic search is the default; advanced search uses more credits. These additional search arguments require Tavily as the selected provider.

With a saved Tavily key, agents also have `web_map` to discover documentation URLs and `web_extract` to read up to ten selected pages as Markdown. Map defaults to depth 1, a 50-link limit, and external links excluded. Extract accepts an optional query for relevant excerpts and basic or advanced extraction. Both tools use Tavily credits and follow the global permission mode. They are available with any selected search provider while Minnow's local server is running.

The **Tavily usage** group shows the saved key's credit usage, account plan usage, pay-as-you-go usage when available, and a breakdown by endpoint. It loads on opening Search Settings; use **Refresh** for an updated reading. These totals can include activity outside Minnow. Unavailable values are labeled explicitly.

**Settings → Integrations → Servers** manages the local processes Minnow runs for you: optional SearXNG and `llama-cpp`. Enable, auto-start and port are configurable for each. SearXNG auto-start is off on new installations; selecting its install during setup turns it on.

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

New subscriptions require an HMAC signing secret of at least 32 characters so your receiver can verify each delivery. API clients can explicitly opt into an unsigned subscription when integrating with a service that cannot verify custom signatures. The signature covers the timestamp and exact request body; receivers should reject stale timestamps and deduplicate the `X-Minnow-Delivery` identifier.

Destinations and signing secrets are encrypted at rest. Settings shows only the destination origin, not credential-bearing paths or query strings, and URLs containing `user:password@host` credentials are rejected. Deliveries time out after 10 seconds and retry three times with backoff. Outgoing URLs are resolved, checked against private and special-use networks, and pinned to the approved address for the connection.

**Delivery is best effort.** Minnow keeps up to 100 queued, running, and delayed-retry deliveries in memory. A full queue drops new deliveries, and stopping or restarting Minnow loses work still pending or retrying. There is no durable outbox or at-least-once delivery guarantee. The `X-Minnow-Delivery` identifier stays the same across retries of one delivery, so receivers can deduplicate attempts they do receive. The Recent deliveries list is a bounded log of final outcomes, not a view of pending sends or every retry.

Webhook payloads contain event identifiers and operational metadata only. They do not contain prompt text or absolute workspace paths.

Useful for wiring a scheduled job's result into Slack, or logging completions somewhere central.

## Native plugins

Plugin packages contribute tools, connections, custom panels and skills. Manage them in **Settings → Plugins**, or ask Minnow to create one with `/build-plugin`. Tools register as `plugin__<package>__<tool>` and retain your permission settings. See [Plugins](../plugins.md) for installation and the authoring API.

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
