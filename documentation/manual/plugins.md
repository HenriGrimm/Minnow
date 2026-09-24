# Plugins

Plugins extend Minnow with agent tools, connections to services, custom panels and slash skills. Manage them in **Settings → Plugins**. They use the same tool permissions and workspace context as chat and the headless CLI.

## Install and manage

Keep a plugin's source folder in your workspace. Enter the folder in Settings → Plugins and select **Review plugin**. Minnow validates its manifest, JavaScript syntax and declared files without executing handlers. Review its source and capabilities, then select **Trust and install**. A content digest prevents installation if the source changes after review.

Native handlers run with your local user privileges. Worker isolation contains ordinary crashes and synchronous hangs; it is **not a security sandbox**. Install only code you trust. A plugin can import Node modules, read files, launch processes and contact services with those privileges. The workspace boundary restricts package installation paths, not trusted handler code.

Each installed plugin has **Enable / Disable**, **Reload from source**, and **Remove** controls. Reload validates and copies the source into a fresh release; invalid packages leave the current release active. Disable removes its tools, panels and skills from discovery and terminates active workers. Remove also deletes saved connections. Plugin-owned persistent data remains on disk.

Expand **Tools, panels and connections** to set each tool to **Ask each time**, **Full permission**, or **Off**, configure connections, or open a panel. Unattended server agents and boards discover plugin tools only when you grant Full permission. Ordinary chat and CLI calls follow the existing approval flow. A plugin installed during a chat becomes discoverable on the next model round.

## Ask Minnow to build a plugin

Use `/build-plugin` and describe the behavior you want. The built-in `plugin_inspect` tool lists packages, validates source, and supplies the API reference with `docs: true`. `plugin_manage` scaffolds, installs, updates, reloads, enables, disables and removes packages. Management mutations are blocked in Plan mode.

For example: “/build-plugin Create a project notes panel with tools to add and search notes, storing them locally.” Minnow creates editable source in your workspace, validates it, and installs a copy. Editing source does not silently change executable code; reload or update applies it live.

## Package contract: API v1

```text
my-plugin/
  plugin.json
  greet.mjs
  panel.html
  README.md
```

```json
{
  "apiVersion": 1,
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "description": "A greeting tool and panel",
  "tools": [{
    "id": "greet",
    "description": "Greet a person",
    "handler": "greet.mjs",
    "parameters": {
      "type": "object",
      "properties": { "name": { "type": "string" } },
      "required": ["name"],
      "additionalProperties": false
    }
  }],
  "panels": [{ "id": "main", "title": "Greeting", "entry": "panel.html" }],
  "connections": [],
  "skills": []
}
```

Plugin ids start with a letter, use lowercase letters, digits and hyphens, and are at most 32 characters. Contribution ids use lowercase letters, digits and underscores, start with a letter and are at most 24 characters. Skill ids use letters and digits. Reserved platform names are rejected. Each package needs at least one tool, panel or skill. Version is semantic version text; `apiVersion` must be `1`.

All declared file paths are relative to the package. Packages allow up to 256 files, 8 MiB, 32 tools, 12 panels, 12 connections and 20 skills. Symlinks, path traversal and special files are rejected. Installation runs no npm scripts and downloads no dependencies. Bundle dependencies into your ESM handlers and assets into your HTML before installation.

## Tools and storage

```js
export default async function greet(args, ctx) {
  return { message: `Hello, ${args.name}!` };
}
```

The tool appears as `plugin__hello__greet`. Hyphens in the plugin id become underscores. Arguments are checked against the declared JSON Schema before invocation. Strings are returned directly; other results are serialized as JSON. Throw an Error for failures.

| Context field | Meaning |
| --- | --- |
| `pluginId` | Owning package id |
| `workspaceRoot` | Workspace of this invocation, including agent worktrees |
| `dataDir` | Durable directory owned by this plugin |
| `connections` | Configured connection values, grouped by connection id and field id |
| `signal` | Deadline signal for fetch and other cancellable operations |

Each invocation uses a fresh worker. Module globals do not persist between calls. Use files under `ctx.dataDir` for durable state and account for concurrent calls. The default deadline is 30 seconds; a tool can set `timeoutMs` between 100 and 120,000. Each worker has a 128 MiB V8 heap limit and a 1 MiB result limit. At most 16 plugin workers run at once. On completion, cancellation, timeout or disable, the worker is terminated. Native subprocesses are not managed by this worker lifecycle; plugins must not start background services.

## Connections

Declare fields in the manifest:

```json
{
  "connections": [{
    "id": "service",
    "label": "Example service",
    "fields": [
      { "id": "url", "label": "Service URL", "secret": false, "required": true },
      { "id": "token", "label": "API token", "secret": true, "required": true }
    ]
  }]
}
```

Users enter values in **Configure connections**. All values are encrypted with Minnow's existing local key. Secret fields return only a configured flag to the UI. A blank field preserves its saved value; **Disconnect all** clears the values. Missing required fields fail the tool with a configuration message.

Handlers read `ctx.connections.service.token` and can use it in server-side requests. Do not return secrets, put them in panels, or log them. Network access and authentication logic belong to native handlers. API v1 provides encrypted fields; it does not automatically provision OAuth clients or MCP servers. Existing MCP connections remain managed under Settings → MCP servers.

## Panels

Panels are self-contained HTML opened from the plugin's settings entry. They run in an opaque-origin iframe with `allow-scripts` only. The content policy permits inline scripts and styles and data-URL images/fonts, while blocking fetch, nested frames, external scripts, forms and objects. Panels cannot read the host DOM, local storage or session tokens.

The host injects one API:

```js
try {
  const result = await minnow.callTool('greet', { name: 'Ada' });
  document.querySelector('#result').textContent = result;
} catch (error) {
  document.querySelector('#result').textContent = error.message;
}
```

The bridge accepts only the owning plugin's declared tools, checks the current release, and dispatches through normal tool permissions. It provides no arbitrary host API and never sends connection secrets to the frame. Results are strings; JSON results can be parsed by the panel. Set loading and error states, use labels and keyboard-accessible controls, and insert tool output with `textContent`. Tool errors may be returned as `Error:` text, following Minnow's tool-result convention.

## Bundled skills

Declare `skills: [{ "id": "helper", "path": "skills/helper/SKILL.md" }]`. The file uses normal skill frontmatter, with `name: plugin-hello-helper` and a description. Enabled package skills appear in the slash catalog. Disable/remove revokes them; updating refreshes their content. Skill names are namespaced so plugins cannot replace built-in instructions.

## API and lifecycle

All HTTP endpoints require the normal Minnow API authentication and workspace scope.

| Endpoint | Operation |
| --- | --- |
| `GET /api/plugins/packages` | Installed packages and catalog revision; no credentials |
| `POST /api/plugins/packages/inspect` | `{path}` for validation and digest, or `{docs:true}` for reference |
| `POST /api/plugins/packages/manage` | `{action,id?,path?,digest?}` |
| `GET/PUT /api/plugins/packages/:id/connections` | Redacted status or `{connections:{connectionId:{fieldId:value}}}` |
| `GET /api/plugins/packages/:id/panels/:panelId` | Enabled panel content and release identity |
| `GET /api/plugins/tools` | Enabled tool definitions, including legacy tools |

Management actions are `scaffold`, `install`, `update`, `reload`, `enable`, `disable` and `remove`. Scaffold creates source only. Install requires `path`. Update requires an installed `id` and accepts a replacement source path. Reload uses the stored source path. Pass the inspected `digest` to reject changed source. Files are staged before the atomic registry switch. The old release remains selected if validation or writing fails. Existing `~/.minnow/tools/<id>/tool.json` plugins retain their compatibility API and tool permissions.

Storage lives under `~/.minnow/plugins/`: `registry.json` selects active releases, `packages/<id>/<release>/` contains installed copies, `connections/<id>.json` holds encrypted fields, and `data/<id>/` holds plugin state. Include this directory and Minnow's `.key` in backups. Interrupted staging can leave unreferenced release folders; these are never discovered or executed.
