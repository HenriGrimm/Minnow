# Plugins

Plugins extend Minnow with apps, menus, custom UI, agent tools, service connections and slash skills. Manage them in **Settings → Plugins**. Build their source in any user workspace; Minnow's core source is not required. Installed packages and connections are shared across your local Minnow profile. Tools receive the invoking workspace, and UI usage APIs follow the workspace of their window.

## Install and manage

Paste a public GitHub URL into **GitHub URL or plugin folder** in Settings → Plugins, or select **Choose folder** to browse for a local plugin. You can also enter a folder path. Local folders can be outside your workspace; choosing one does not switch projects. A plugin folder contains `plugin.json` and its bundled files. Repository URLs use the root plugin, or find a single plugin in a subfolder automatically. If the repository contains multiple plugins, paste the desired GitHub folder link, such as `https://github.com/owner/repository/tree/main/plugins/my-plugin`.

Select **Review plugin**. Minnow downloads a GitHub source archive and validates the manifest, JavaScript syntax and declared files without executing handlers or install scripts. Review its source and capabilities, then select **Trust and install** (or **Trust and update** for an installed plugin). GitHub installations use the commit recorded in the reviewed archive; a content digest prevents installation if the reviewed files change. Public imports need no account token and do not use GitHub's REST API allowance. Repository archives are limited to 16 MiB compressed and 64 MiB unpacked; use a local folder for larger repositories. Plugin limits are 256 files and 8 MiB; links and special files are rejected. GitHub archives omit submodule contents, so bundle required files into the plugin. Local Git metadata (`.git`) is excluded.

Native handlers run with your local user privileges. Worker isolation contains ordinary crashes and synchronous hangs; it is **not a security sandbox**. Install only code you trust. A plugin can import Node modules, read files, launch processes and contact services with those privileges. Agent tools retain their filesystem policy for local package paths; Settings accepts the folder you explicitly choose.

Optional **UI modules are also trusted code**. They run in Minnow's document and can change the DOM, access browser storage and call authenticated APIs. Review their source along with native handlers. Settings panels remain isolated iframes; installing a UI module grants broader access than opening a panel.

Each installed plugin has **Enable / Disable**, **Reload from source**, and **Remove** controls. Reload validates and copies the source into a fresh release; GitHub sources download the current commit for the original repository or branch link. Invalid packages or failed downloads leave the current release active. Disable removes its tools, panels and skills from discovery and terminates active workers. Remove also deletes saved connections. Plugin-owned persistent data remains on disk.

UI contributions load at startup and refresh live on install, reload, disable and remove. Other open Minnow windows check the catalog every three seconds. Managed mounts, apps, menus, commands and subscriptions are disposed on unload. A UI initialization error removes that module's managed contributions and appears in Settings; fix the source and reload. Reload requires the source folder or GitHub repository to remain available.

Expand **Tools, panels and connections** to set each tool to **Ask each time**, **Full permission**, or **Off**, configure connections, or open a panel. Unattended server agents and boards discover plugin tools only when you grant Full permission. Ordinary chat and CLI calls follow the existing approval flow. A plugin installed during a chat becomes discoverable on the next model round.

## Ask Minnow to build a plugin

Use `/build-plugin` and describe the behavior you want. The built-in `plugin_inspect` tool lists packages, validates source, and supplies the API reference with `docs: true`. `plugin_manage` scaffolds, installs, updates, reloads, enables, disables and removes packages. Management mutations are blocked in Plan mode.

For example: “/build-plugin Create a project notes app with tools to add and search notes, storing them locally.” Or: “/build-plugin Show cumulative chat tokens next to tokens per second.” Minnow creates editable source in your workspace, validates it, and installs a copy. Editing source does not silently change executable code; reload or update applies it live. Use Build mode for authoring; Plan mode can document the design. CLI-backed models use Minnow's supplied editing and plugin tools even when their native filesystem sandbox is read-only.

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

Plugin ids start with a letter, use lowercase letters, digits and hyphens, and are at most 32 characters. Contribution ids use lowercase letters, digits and underscores, start with a letter and are at most 24 characters. Skill ids use letters and digits. Reserved platform names are rejected. Each package needs at least one tool, panel, skill or UI module. Version is semantic version text; `apiVersion` must be `1`.

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

## Apps, menus and DOM extensions

Add a trusted frontend entry to `plugin.json`:

```json
"ui": { "entry": "ui.mjs" }
```

The entry exports a default activation function. Bundle frontend dependencies into this one `.mjs` file; package-relative imports are not supported. Source is fetched through the authenticated plugin route and imported as a module. It executes in the host document, so standard DOM APIs are available. Use Minnow's `--mn-*` CSS tokens, labelled controls and keyboard-accessible actions.

```js
export default function activate(ctx) {
  const app = ctx.registerApp(
    { id: 'notes', name: 'Project notes', icon: 'fileText' },
    root => {
      const heading = document.createElement('h1');
      heading.textContent = 'Project notes';
      root.append(heading);
      // Return a cleanup function for app-specific resources when needed.
    }
  );
  ctx.registerMenu('notes', () => [
    { id: 'open_notes', label: 'Project notes', onSelect: () => app.launch() }
  ], { kinds: ['menubar.plugins', 'app.rail'] });
  ctx.registerCommand({
    id: 'notes', title: 'Open project notes', group: 'Plugins',
    run: () => app.launch()
  });
}
```

App ids are namespaced as `plugin-<package>--<app>`. Apps appear in the app rail and the app command palette and open at `#/app/<namespaced-id>`. Mount callbacks run lazily on first launch and may return cleanup functions. Plugin apps share the main window; the built-in native "Open in new window" action is not offered for them.

| UI context API | Behavior |
| --- | --- |
| `pluginId`, `signal` | Owning package and an abort signal fired on unload |
| `onCleanup(fn)` | Register a disposer; also returns an idempotent disposer |
| `mount(selector, render, position?)` | Add DOM at matching targets and remount when core UI replaces them |
| `mountSlot(name, render, position?)` | Mount at a stable named target |
| `registerApp(options, mount)` | Register a rail app; returns `{id, launch}` |
| `registerMenu(id, contribute, options?)` | Contribute rows to registered menus, optionally filtered by `kinds` |
| `openMenu(options)` | Open a custom menu using Minnow's menu renderer |
| `registerCommand(command)` | Register a namespaced command palette action |
| `registerSlashCommand(command)` | Register a local `/` action and picker entry; optional short alias |
| `callTool(id, args)` | Call this package's declared tool through permission and release checks; returns a string |
| `getChatUsage(chatId?)`, `onChatUsage(fn, chatId?)` | Read or subscribe to a chat's copied usage snapshot |
| `getWorkspaceUsage()`, `onWorkspaceUsage(fn)` | Read or subscribe to the current workspace's cumulative totals |

`render(target)` returns a new `HTMLElement` or `{element, dispose}`. The positions are `append` (default), `prepend`, `before` and `after`. Each matching target gets its own element. The per-mount disposer runs when the target is removed or rebuilt. Returned subscription and registration disposers can be called early; they also run on plugin unload. Direct DOM changes, listeners, timers and other resources outside these helpers need explicit `onCleanup` handlers. Trusted UI code is not isolated from synchronous hangs or other host-document side effects.

Stable slots are `menubar`, `chat.throughput` (the Code status bar and metrics strip's TPS values), `chat.message-throughput` (a message's TPS chip), and `chat.message-metrics` (the message metrics row). Arbitrary CSS selectors and direct DOM changes are supported; core classes and ids outside these named slots can change between releases.

The top **Plugin commands** menu uses `menubar.plugins`; app rail context menus use `app.rail` with `appId`. Existing registered targets include `chat-message` and `terminal-selection` with text context. Menu contributors receive the target and return Minnow menu items: actions, submenus, separators or headings. Actions have `id`, `label` and `onSelect`; use `hint`, `disabled`, `checked` or `shortcut` where appropriate. `ctx.openMenu` accepts `target`, `items`, `label`, and an anchor or pointer coordinates for custom surfaces.

## Chat usage and token counters

Usage APIs are scoped to the renderer's workspace. Without a `chatId`, the chat API follows the active chat. A missing chat or a chat in another workspace returns `null`. Subscriptions deliver an initial snapshot and coalesced updates for usage, live metrics, chat selection, clearing history and workspace changes.

Chat snapshots include `chatId`, `workspacePath`, `streaming`, `totals`, `bySource`, `current` last/live metrics, and the `latest` completed ledger entry. Totals contain `promptTokens`, `completionTokens`, `totalTokens`, `costUsd` and `completionCount`. The latest entry includes its id, timestamp, source, provider/model, usage, stats and cost. Snapshots are copies; changing one does not change the chat. Message text, prompts and connection credentials are not included.

Display `totals.totalTokens` directly. It counts completed requests, including repeated prompt tokens, sub-agent work, titles and utility requests recorded on that chat. It is separate from context-window capacity and from live token estimates. **Do not add successive snapshots together.** Clearing history resets the ledger. Workspace totals sum retained chats in the current workspace, so deleting a chat removes its contribution. Requests without measurable provider usage are not counted; estimated cost depends on configured pricing.

```js
export default function activate(ctx) {
  ctx.mountSlot('chat.throughput', () => {
    const total = document.createElement('span');
    total.className = 'stat-unit';
    const unsubscribe = ctx.onChatUsage(usage => {
      total.textContent = ` · ${(usage?.totals.totalTokens ?? 0).toLocaleString()} chat tokens`;
    });
    return { element: total, dispose: unsubscribe };
  });
}
```

The [chat token counter example](../../examples/plugins/chat-token-counter/README.md) adds this counter, a token usage app, menu actions and a command palette entry. Copy its folder into your workspace, review and install it through Settings → Plugins. UI-only packages need no native tools or connection fields.

## Bundled skills

Plugins support two kinds of `/` commands. **Direct commands** execute a UI handler without calling the model. Register one in your trusted UI module:

```js
ctx.registerSlashCommand({
  id: 'tokens', alias: 'tokens', label: 'Token usage',
  description: 'Open chat and workspace token totals',
  run: ({ args, chatId, workspacePath }) => app.launch()
});
```

The canonical command is `/plugin-<package>--tokens`. A short alias such as `/tokens` is optional and cannot replace a built-in command, skill or another plugin's alias. Direct commands appear in the composer `/` picker, receive the remaining text as `args`, and run before model selection or generation, including while a reply is streaming. Errors remain local and keep the input for correction. Disable, remove and reload revoke their handlers and picker entries. Direct UI commands run in the SPA; use a bundled skill and native tools for workflows shared with the headless CLI.

**Slash skills** give the agent reusable instructions and tools:

Declare `skills: [{ "id": "helper", "path": "skills/helper/SKILL.md" }]`. The file uses normal skill frontmatter, with `name: plugin-hello-helper` and a description. Enabled package skills appear in the slash catalog. Disable/remove revokes them; updating refreshes their content. Skill names are namespaced so plugins cannot replace built-in instructions.

## API and lifecycle

All HTTP endpoints require the normal Minnow API authentication and workspace scope.

| Endpoint | Operation |
| --- | --- |
| `GET /api/plugins/packages` | Installed packages and catalog revision; no credentials |
| `POST /api/plugins/packages/inspect` | `{source}` for a GitHub URL or explicit local folder; `{path}` for a filesystem-policy-scoped folder; returns validation and digest, plus a commit for GitHub. `{docs:true}` returns the reference |
| `POST /api/plugins/packages/manage` | `{action,id?,source?,path?,digest?,commit?}` |
| `GET/PUT /api/plugins/packages/:id/connections` | Redacted status or `{connections:{connectionId:{fieldId:value}}}` |
| `GET /api/plugins/packages/:id/panels/:panelId` | Enabled panel content and release identity |
| `GET /api/plugins/packages/:id/ui/:release` | Declared UI module source and tool ids for the pinned, enabled release; no credentials |
| `GET /api/plugins/tools` | Enabled tool definitions, including legacy tools |

Management actions are `scaffold`, `install`, `update`, `reload`, `enable`, `disable` and `remove`. Scaffold creates source only. Install requires `source` or `path`. Update requires an installed `id` and accepts a replacement source. Reload uses the stored source. Pass the inspected `digest` to reject changed files, and the inspected `commit` to install the reviewed GitHub snapshot. Files are staged before the atomic registry switch. The old release remains selected if validation or writing fails. Existing `~/.minnow/tools/<id>/tool.json` plugins retain their compatibility API and tool permissions.

Storage lives under `~/.minnow/plugins/`: `registry.json` selects active releases, `packages/<id>/<release>/` contains installed copies, `connections/<id>.json` holds encrypted fields, and `data/<id>/` holds plugin state. Include this directory and Minnow's `.key` in backups. Interrupted staging can leave unreferenced release folders; these are never discovered or executed.
