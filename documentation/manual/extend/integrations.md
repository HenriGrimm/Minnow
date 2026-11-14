# Connect tools to a workspace

## MCP servers

1. Open **Settings → Extensions → MCP servers**.
2. Paste your service's `mcpServers` configuration and choose **Add servers**. A remote server can use a URL and headers. A local server uses a command and arguments, with optional environment variables and working directory.
3. If the server requires authorization, choose **Sign in** and complete the flow. Use **Refresh connection** when it fails to connect and **Refresh tools** if the tool list is stale.
4. From a thread, ask the agent to find and use one tool from that server. Tool calls use the usual [permissions](../concepts/tools-and-permissions.md). Disable or remove the server to withdraw the tools.

To provide Minnow tools to another agent, use [Connect other agents to Minnow](mcp-hub.md).

## Language servers

Open **Settings → Code and workspace → Language servers**. Check the server for the file's language and install its prerequisites when required. Reopen the file and try completion or go to definition. If results point to a different checkout, check the thread card and workspace.

## Browser automation

Open **Browser** from the Code surface launcher for a page you want to see yourself. Use the desktop shell for the native preview and browser tools. For separate agent work, ask the agent to reserve its own Agent Browser tab and select that tab in its viewer when you need to inspect progress. Enable **Use native browser for new agent tabs** in Browser settings to watch a native tab where supported.

In the viewer, choose **Take control** to use the page directly, then **Watch** to hand it back. Use **Guide** to point to an element and send a note to the owning agent. Agent Browser tab storage is disposable. Browser navigation uses the usual agent permission setting.

## Web search and outbound webhooks

Search Settings for **Web search** to select a provider and configure its key if required. Try a concrete search in a thread. If it fails, check the provider and any local service it needs.

Search Settings for **Webhooks** to configure signed outbound events. Add the destination and events you need, then test delivery and inspect the receiving service. For trusted local extension packages, see [Plugins](../plugins.md).
