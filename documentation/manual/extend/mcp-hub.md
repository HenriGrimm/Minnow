# Connect other agents to Minnow

Keep Minnow running on the computer that holds the project. Open the project once so the hub can recognize its folder. The hub lets another agent work with Minnow issues, Brain pages, and the shipped manual.

## Connect over HTTP

1. Open **Settings → Extensions → Connect other apps**. Choose **HTTP**, give the connection a name, and choose **Read only** or **Read and write**.
2. Select **Create connection** and **Copy configuration**. Save it into your agent's MCP settings while the token is visible. Choose **Streamable HTTP** if asked for a transport.
3. From the other agent, call `issue_list` with `workspace_path` set to the absolute path of the project. An unknown workspace means the path is unavailable or has not been registered with Minnow.
4. Use **Saved HTTP connections** to revoke access or replace a token. After replacement, paste the new configuration into the client.

A read-only credential keeps that scope after replacing the token. For a tool that writes Brain pages, read the current page first so your update preserves the intended content.

## Connect over stdio

Use **Local command (stdio)** with a source checkout, Node.js, and that checkout's installed dependencies. The command is `node /absolute/path/to/Minnow/bin/minnow.mjs mcp`. Use HTTP with a packaged build on its own.

The bridge uses the supplied `workspace_path` or a single client root. Run `minnow mcp --help` for overrides such as **--base-url** or **--read-only**.

## What the connection exposes

Use `issue_list` and `issue_get` for workspace issues, and `issue_taxonomy` to discover workflow IDs before writing. Use `brain_search` followed by `brain_read_page` for project decisions, or `minnow_docs_search` followed by `minnow_docs_read` for help using Minnow.
