# Settings

Open Settings from the menubar gear. Pages are grouped by what you want to change. Model configuration lives in the [Models app](models.md).

## Find a setting

Press **Ctrl+K** / **Cmd+K** with Settings open. Search for a setting or an everyday phrase such as "stop sounds", "backups", or "let agents edit files". Choose a result to open its page and highlight the control.

Search also opens related settings in **Brain** and **Models**. Sidebar groups expand independently, so you can keep frequently used pages visible.

## The map

| Group | Pages |
|-------|-------|
| **General** | Startup & setup, Appearance, Notifications, Audio |
| **Code & workspace** | Editor, Terminal, Language servers, Browser, Issues |
| **AI & agents** | Models & connections, Agents, Chat context, Rules, Tool permissions, Autopilot, Timeouts & recovery |
| **Extensions** | Plugins, Skills, Skills Library, Agent packs, Web search, MCP servers, Connect other apps, Servers, Webhooks |
| **Data & privacy** | Backups & access |
| **About & troubleshooting** | About, Updates, Health & diagnostics |

### General

**Startup & setup** controls desktop tray behavior and launch at startup. It also links to common settings and lets you run setup again.

**Appearance** includes interface zoom in the desktop app, Compact or Full chat view, eight theme families with dark and light variants, fonts, and custom colors. Changes apply immediately. In a browser, use the browser's zoom controls.

**Notifications** controls bell alerts, desktop notifications, and sound packs. **Test desktop notification** checks system delivery. Individual resets restore a preference to its default; **Show modified only** helps you find changes.

**Audio** selects input and output devices and microphone processing. Speech recognition and read-aloud models live in **Models → Voice**.

### Code & workspace

**Editor** controls wrapping, indentation, inline AI suggestions, their context, and their model. **Terminal** controls panel behavior and the default shell, with workspace overrides. **Language servers** configures code diagnostics and symbol completions.

**Browser** controls the preview panel, navigation permission, restored tabs, and allowed origins. **Issues** configures issue IDs, GitHub sync, types, statuses, priorities, and defaults.

### AI & agents

**Models & connections** opens Models. **Agents** configures shared prompt profiles, composer modes, work agents, sub-agent types, and context policy. **Chat context** chooses the default Brain notes, code map, and project documents added to chats. **Rules** manages standing instructions.

**Tool permissions** provides Off, Ask, and Full permissions by tool. Advanced controls cover structured arguments, tool loading, caching, and result size.

**Autopilot** sets board defaults for task concurrency, git worktrees, retries, planner fallback, and recovery. Each board can override these defaults. **Timeouts & recovery** sets idle and maximum durations for model responses and describes sub-agent recovery.

### Extensions

**Plugins** installs and manages local extension packages. Review a workspace folder, then install it and configure its connections, tools, skills, or panels. See [Plugins](../plugins.md).

**Skills** manages installed agent instructions. **Skills Library** is a separate page for browsing and installing third-party collections; expand **Add from GitHub URL** to install a skill folder from a repository. **Agent packs** shows installed collections first, with ZIP upload and optional pack creation instructions below.

**Web search** selects a provider and API keys. **Servers** manages local services such as SearXNG; model hosting lives in Models. **MCP servers** adds tools from external Model Context Protocol servers. **Connect other apps** gives other agents access to Minnow's Issues, Brain, and manual. **Webhooks** sends signed event notifications to other services.

### Data & privacy

**Backups & access** manages [backups and restore](../reference/backup-and-restore.md), filesystem access, the agent shell sandbox, and network access.

File and git tools stay inside open workspaces by default. Network access is local to this computer by default; enabling LAN access requires a restart. See [Tools and permissions](../concepts/tools-and-permissions.md) and [Use Minnow from another device](../extend/companion.md).

### About & troubleshooting

**About** shows version, runtime, storage, and startup diagnostics. **Updates** checks for new builds and controls the update channel. **Health & diagnostics** shows subsystem health, captured errors, local logs, and a redacted report you can copy.

## Where settings are stored

Settings are saved in your Minnow home in files such as config.json, tools.json, search.json, rules.json, and skills.json. Secrets are encrypted. Browser-only appearance preferences are saved on the device.

See [Where your data lives](../reference/configuration.md).
