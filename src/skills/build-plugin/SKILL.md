---
name: build-plugin
label: Build a plugin
description: Build, validate, install and update Minnow plugins with tools, connections, custom UI panels and bundled skills.
---

Build the requested extension as a Minnow API v1 plugin in the current workspace.

1. Call `plugin_inspect` with `docs: true` for the runtime contract. Call `minnow_docs_read` with `path: "manual/plugins.md"` for the full reference. Inspect installed packages to avoid duplicate ids.
2. Plan the smallest complete plugin that solves the request: tool inputs and outputs, connections and secret fields, panels and skill entry points. Use the existing workspace conventions. In Plan mode, document the design without installing or changing plugins.
3. Call `plugin_manage` with `action: scaffold`, a lowercase hyphenated `id`, and a workspace-relative `path`. This creates source files without installing them. Edit source with normal file tools. Do not edit Minnow's installation or managed package releases.
4. Implement native ESM `.mjs` handlers with a default function `(args, ctx)`. Use `ctx.workspaceRoot`, `ctx.dataDir`, `ctx.connections` and `ctx.signal`. Do not assume the current working directory is the user's workspace. Bundle third-party dependencies before installation. Do not run background daemons. Never place credentials in source, tool arguments, logs, results or panels.
5. Panels are self-contained HTML/CSS/JS. Use `await minnow.callTool(toolId, args)` for this plugin's declared tools. Handle errors and pending state, label inputs, support keyboard navigation and responsive layouts. Panels cannot access the host DOM or tokens. Use data URLs for static assets or inline them at build time.
6. Write meaningful tests for normal behavior, invalid arguments, provider errors, timeouts and persistence where relevant. Validate the package using `plugin_inspect` with `path`. Resolve all failures before activation.
7. Installation executes trusted local code when tools are called. Explain the concrete capabilities. Respect existing authorization and Minnow's tool approval flow; do not disable permissions to make an install work. Call `plugin_manage` with `action: install`, `path`, and the inspected `digest`. Existing plugins use `update` with `id`, `path` and `digest`, or `reload` from their last source. Tool and skill discovery refresh live.
8. Verify the installed tool through its `plugin__<id>__<tool>` name and open any panel in Settings → Plugins. If credentials are required, have the user configure the encrypted fields there; never invent credentials. Report actual validation performed and any untested external connection.

Keep source, a README, and tests in the workspace. Document configuration, example calls, errors, data storage, installation and removal. Disable the plugin if verification exposes a defect, fix the source, inspect, update and re-enable. Removal revokes tools/panels/skills and clears connections; persistent plugin data is retained.
