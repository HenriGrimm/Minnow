> For new multi-tool packages, connections, panels and skills, use the [Plugin API v1 guide](../manual/plugins.md). This page documents the compatible legacy single-tool format.

# Native tool plugin authoring

Minnow can load **local tool plugins** from `~/.minnow/tools/<pluginId>/` without running a separate MCP server. Each pack contains a JSON manifest and a single JavaScript handler executed on the Node tool server (`npm start`).

## Layout

```text
~/.minnow/tools/<pluginId>/
  tool.json       # metadata + OpenAI parameters schema
  handler.mjs     # export default async function handler(args, ctx)
```

The folder name must match `tool.json` → `id`. Plugin ids use lowercase letters, numbers, and hyphens (`^[a-z0-9][a-z0-9-]*$`).

## Exposed tool name

The model sees:

```text
plugin__<pluginId>__<functionName>
```

Hyphens in the plugin id become underscores in the namespace segment only. Example: id `hello-world` + function `greet` → `plugin__hello_world__greet`.

## tool.json

See [`documentation/schemas/tool-plugin.schema.json`](../schemas/tool-plugin.schema.json).

Required fields: `id`, `functionName`, `label`, `description`, `category`, `parameters` (JSON Schema object).

Optional `capabilities` (v1 metadata for future gating):

| Field | Default | Meaning |
|-------|---------|---------|
| `filesystem` | `false` | Declares filesystem access needs |
| `network` | `false` | Declares network access needs |
| `nodeBuiltin` | `false` | Reserved for trusted Node builtins |

## handler.mjs

```javascript
/**
 * @param {Record<string, unknown>} args — arguments from the model
 * @param {import('../../server/tools/plugin-context.js').PluginContext} ctx
 * @returns {Promise<string>} — result text (use "Error: …" for failures)
 */
export default async function handler(args, ctx) {
  return `Hello, ${args.name ?? 'world'}`;
}
```

`ctx` provides:

- `workspaceRoot` — active workspace path
- `minnowHome` — `~/.minnow` (or `MINNOW_HOME`)
- `log(message)` — server log line
- `env` — read-only `NODE_ENV`, `MINNOW_HOME`

Return a **string** from the handler. Uncaught errors are converted to `Error: …` strings by the server.

## Enablement and permissions

`~/.minnow/tools.json`:

```json
{
  "plugins": {
    "my-plugin": { "enabled": true }
  },
  "permissions": {
    "default": {
      "plugin__my_plugin__greet": "ask"
    }
  }
}
```

- `plugins.<id>.enabled: false` removes the tool from `GET /api/plugins/tools` and from chat tool lists.
- `permissions.default.<namespacedName>` uses `full`, `ask`, or `off` (default for new plugin tools is `ask`).

Configure in **Settings → Tools → Plugins**, or edit `tools.json` directly.

## APIs

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/plugins/ping` | Health check |
| GET | `/api/plugins` | List plugin metadata |
| GET | `/api/plugins/tools` | OpenAI function definitions (enabled packs) |
| POST | `/api/plugins/reload` | Rescan packs and clear handler cache |
| POST | `/api/plugins/scaffold` | Copy `_template` to `~/.minnow/tools/<id>/` |

Execution uses the same path as built-in server tools: `POST /api/tools` with `{ "name": "plugin__…", "args": {} }`.

## Scaffold

With `npm start` running:

```bash
curl -X POST http://localhost:9473/api/plugins/scaffold \
  -H 'Content-Type: application/json' \
  -d '{"id":"demo"}'
```

Or use **Scaffold new plugin…** in Settings → Tools → Plugins.

## Sandbox and trust

By default, handlers run in a **Node `vm` wrapper** with a minimal sandbox (`args`, `ctx`, limited `console.log`). For local development only, set `MINNOW_PLUGIN_UNSAFE=1` to load handlers via full dynamic `import()` (same OS user as the dev server — only use on trusted code).

## Comparison with MCP

| | MCP | Native plugin |
|---|-----|----------------|
| Process | Separate stdio server | In-process handler |
| Naming | `mcp__server__tool` | `plugin__id__function` |
| Best for | Existing MCP tools | Quick local extensions |

## Tests

```bash
npm run test:plugins
```

Fixtures live under `test/fixtures/plugin-tools/echo/` (`plugin__echo__ping` → `pong`).
