# Connect other agents to Minnow

Minnow provides an MCP server so external agents can use its Issues tracker, Brain wiki, and user manual. Keep Minnow running and open the project folder you want the agent to work with.

Open **Settings → Integrations → MCP hub** to check the connection and copy a configuration for your current workspace. Choose **HTTP** or, when a local source checkout is available, **Local command (stdio)**. Select **Read and write** or **Read only** for the connection. The preview hides your session token; **Copy configuration** includes it for HTTP. The page lists the tools available with the selected access.

## Connect over stdio

With a Minnow source checkout and its dependencies installed, add this entry to your agent's MCP configuration. Replace both paths with absolute paths on your computer. Use forward slashes in JSON paths on Windows.

```json
{
  "mcpServers": {
    "minnow": {
      "command": "node",
      "args": [
        "C:/path/to/Minnow/bin/minnow.mjs",
        "mcp",
        "--workspace",
        "C:/path/to/your/project"
      ]
    }
  }
}
```

The bridge connects to `http://127.0.0.1:9473` and reads the local session token automatically. If Minnow uses another port, add `--base-url` and its loopback URL to `args`. If you use a custom data folder, set `MINNOW_HOME` in the MCP entry's `env`. `MINNOW_TOKEN` optionally overrides the token file. The bridge reads the token for every request, including after Minnow restarts. It does not start Minnow itself.

Add `--read-only` to omit and reject tools that write data. To see the command options, run `node /path/to/Minnow/bin/minnow.mjs mcp --help`.

## Connect over HTTP

Agents supporting Streamable HTTP can connect directly to a running Minnow desktop or development host:

```json
{
  "mcpServers": {
    "minnow": {
      "url": "http://127.0.0.1:9473/api/mcp/hub",
      "headers": {
        "X-Minnow-Token": "YOUR_CURRENT_SESSION_TOKEN",
        "X-Minnow-Workspace": "C:/path/to/your/project"
      }
    }
  }
}
```

Minnow creates the session token automatically. In **Settings → Integrations → MCP hub**, choose **HTTP** and click **Copy session token** if your client asks for the `X-Minnow-Token` header separately. **Copy configuration** includes the token for you. It changes when Minnow restarts; update direct HTTP configurations then. The token is also stored in `~/.minnow/session-token` (or your `MINNOW_HOME` folder). Client configuration formats vary: select **Streamable HTTP** if your client asks for a transport. Append `?readOnly=1` to the URL for a read-only connection.

The token is a Minnow host credential; share it only with trusted clients. The read-only option limits this connection's tools, not the credential's permissions on other Minnow APIs. The stdio bridge only forwards credentials to loopback addresses. Remote HTTP access follows Minnow's existing opt-in network access and authentication settings.

## Available tools

| Area | Tools | Scope |
|------|-------|-------|
| Issues | `issue_list`, `issue_get`, `issue_create`, `issue_edit`, `issue_comment` | Connected workspace |
| Projects and workflow | `issue_projects`, `issue_taxonomy` | Shared project catalog and taxonomy |
| Brain | `brain_search`, `brain_list`, `brain_read_page`, `brain_write_page`, `brain_append_log` | Shared wiki; search uses workspace context plus global pages |
| Manual | `minnow_docs_search`, `minnow_docs_read`, `minnow_docs_list` | Shipped user manual |

Connections stay bound to their configured workspace when you switch projects in Minnow. Issues from other workspaces cannot be read or edited through that connection. Brain pages remain shared, just as they are inside Minnow. Writing a Brain page replaces its body; read the existing page before updating it.

Agents can list projects and place an issue into one using `project_id`; project creation and administration remain in Minnow. Read `issue_taxonomy` to discover valid type, status, and priority ids. `issue_list` supports a text query, status and project filters, closed issues, and pagination. Use `issue_get` for full descriptions and comments. Pass its `updatedAt` value as `expected_updated_at` to `issue_edit` to reject an edit if someone changed the issue in the meantime.

For example, ask your agent: “Find my open issues in Minnow, read the relevant Brain pages, work on the selected issue, and leave a progress comment.” These tools use Minnow's existing storage. Visible Minnow windows refresh issue changes within about five seconds; independent edits merge on save, and conflicting simultaneous issue creation fails visibly.

The hub does not expose command execution, file editing, credentials, or destructive bulk operations. Your external agent uses its own development tools for the code work.
