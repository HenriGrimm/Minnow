# Connect other agents to Minnow

Minnow provides an MCP server so external agents can use its Issues tracker, Brain wiki, and user manual. Keep Minnow running. One connection works across projects: the requesting agent supplies its current workspace, and Minnow validates that folder against its open/recent workspaces and registered worktrees.

Open **Settings → Integrations → MCP hub** to check the connection and copy a reusable agent configuration. You can set up a connection before opening a project folder. Choose **HTTP** or **Local command (stdio)**. Select **Read and write** or **Read only** for the connection. HTTP defaults to a persistent connection; give it a name and click **Create connection**. Save the displayed configuration now with **Copy configuration**, or use **Copy connection token** if your client asks for the header separately. Minnow shows this token only during creation or replacement. **Hide token** clears it from the page. The page lists the tools available with the selected access.

Persistent HTTP credentials survive Minnow restarts until you replace or revoke them. New credentials authorize only `/api/mcp/hub` across allowed workspaces, with their saved read/write level enforced by the server. Removing `readOnly=1` from the URL or changing headers cannot elevate a read-only credential. Brain pages and the project catalog remain shared across Minnow.

**Saved HTTP connections** lists names, access, creation time, and last use. Agent-workspace connections appear across projects; legacy folder-bound connections appear for their folder. **Revoke** stops access immediately. **Replace** invalidates the old token immediately and shows a new one once, retaining the connection’s name, scope, and access. Update your agent with that new configuration. Refreshing or leaving this page clears the displayed token; replace the connection if you did not save it. Minnow stores only token hashes under `~/.minnow/auth/mcp-connections.json` (or your `MINNOW_HOME` folder).

## Connect over stdio

The current bridge requires **Node.js**, a **Minnow source checkout**, and that checkout’s dependencies installed on the same computer. Packaged desktop builds keep **Local command (stdio)** visible with an explanation: external Node cannot run the bridge from the packaged archive. Use persistent HTTP there, or run the bridge from a separate source checkout. Remote browser connections also need HTTP. The hub does not install the bridge automatically.

With a source checkout ready, add this entry to your agent's MCP configuration. Replace the Minnow path with an absolute path on your computer. Use forward slashes in JSON paths on Windows.

```json
{
  "mcpServers": {
    "minnow": {
      "command": "node",
      "args": [
        "C:/path/to/Minnow/bin/minnow.mjs",
        "mcp"
      ]
    }
  }
}
```

On each call, the bridge uses the tool’s `workspace_path` if provided, otherwise requests the agent’s MCP roots. A single root selects that folder; multiple or missing roots require `workspace_path` rather than guessing. If the client does not support roots, the bridge uses its launch directory. Clients that launch MCP processes from a fixed directory should supply their current workspace in each call. The optional legacy `--workspace` flag supplies a fallback only when roots are unsupported.

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
        "X-Minnow-Token": "YOUR_MCP_CONNECTION_TOKEN"
      }
    }
  }
}
```

Use **Create connection** in the hub to generate the persistent token. **Copy configuration** includes it for you. Client configuration formats vary: select **Streamable HTTP** if your client asks for a transport. Each HTTP tool accepts `workspace_path`, the absolute path of the agent’s current project. For example, call `issue_list` with `{"workspace_path":"C:/path/to/your/project"}`. The server instructions and tool schemas tell the agent to supply this value. Missing, relative, unavailable, or unknown workspaces fail visibly. The stateless HTTP transport does not request client roots. The folder must be available to Minnow; open it once in Minnow if it is not recognized. Append `?readOnly=1` to further restrict a read/write connection; a saved read-only connection is always read-only.

Existing HTTP configurations using the per-boot host session token still work. Select **Current host session (legacy)** to copy that configuration or **Copy session token**. This token changes when Minnow restarts and is stored in `~/.minnow/session-token`. It authorizes other Minnow APIs; its URL’s read-only option only limits the hub tools. Share it only with trusted clients. Prefer a persistent MCP credential for new HTTP connections.

The stdio bridge still reads the current host session token file on every request and only forwards credentials to loopback addresses. Remote HTTP access follows Minnow's existing opt-in network access and authentication settings. Creating, listing, replacing, and revoking persistent credentials require a host session; MCP credentials cannot manage themselves.

## Available tools

| Area | Tools | Scope |
|------|-------|-------|
| Issues | `issue_list`, `issue_get`, `issue_create`, `issue_edit`, `issue_comment` | Connected workspace |
| Projects and workflow | `issue_projects`, `issue_taxonomy` | Shared project catalog and taxonomy |
| Brain | `brain_search`, `brain_list`, `brain_read_page`, `brain_write_page`, `brain_append_log` | Shared wiki; search uses workspace context plus global pages |
| Manual | `minnow_docs_search`, `minnow_docs_read`, `minnow_docs_list` | Shipped user manual |

Workspace selection follows each agent call, independently of the active Minnow window. Issue lookups and edits stay restricted to the workspace selected for that call. Existing workspace-bound HTTP credentials keep their original restriction, including after replacement; create a new connection and copy its configuration once to enable workspace switching. Legacy HTTP workspace headers remain supported as a per-request fallback. Brain pages remain shared, just as they are inside Minnow. Writing a Brain page replaces its body; read the existing page before updating it.

Agents can list projects and place an issue into one using `project_id`; project creation and administration remain in Minnow. Read `issue_taxonomy` to discover valid type, status, and priority ids. `issue_list` supports a text query, status and project filters, closed issues, and pagination. Use `issue_get` for full descriptions and comments. Pass its `updatedAt` value as `expected_updated_at` to `issue_edit` to reject an edit if someone changed the issue in the meantime.

For example, ask your agent: “Find my open issues in Minnow, read the relevant Brain pages, work on the selected issue, and leave a progress comment.” These tools use Minnow's existing storage. Visible Minnow windows refresh issue changes within about five seconds; independent edits merge on save, and conflicting simultaneous issue creation fails visibly.

The hub does not expose command execution, file editing, credentials, or destructive bulk operations. Your external agent uses its own development tools for the code work.
