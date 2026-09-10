# Where your data lives

Everything Minnow keeps lives in one folder, called **Minnow home**. Chats, settings, your Brain wiki, encrypted credentials, downloaded models, logs — all of it, in files you can inspect, back up, or delete.

| Platform | Path |
|----------|------|
| Windows | `%USERPROFILE%\.minnow` |
| macOS and Linux | `~/.minnow` |

Set the `MINNOW_HOME` environment variable to use a different folder — useful for a clean profile to experiment in without touching your real one.

Minnow creates every folder it might need on first run, so empty directories in there are normal and not a sign of anything wrong.

## What to back up

If you only save four things, save these:

| Item | Why |
|------|-----|
| **`.key`** | The encryption key for every secret Minnow holds — API keys, OAuth tokens, mail passwords, webhook secrets. **Lose this and none of them can be decrypted.** There is no recovery; you re-enter everything. |
| **`sessions/`** | Your entire chat history |
| **`brain/`** | Your knowledge wiki and memories |
| **`config.json`** | Your preferences |

The simplest approach is to back up the whole `.minnow` folder and exclude `models/`, which is large and re-downloadable.

`.key` deserves a moment of thought before you reinstall an operating system. It is a small file; put a copy somewhere safe, and treat that copy with the same care as the credentials it protects.

## The layout

| Path | Contents |
|------|----------|
| `config.json` | Workspace, features, voice, terminal, tool security, fallbacks |
| `.key` | The encryption key for secrets (restricted permissions on Unix) |
| `sessions/` | Chat history in SQLite, with a full-text search index |
| `sessions/snapshots/` | Rotating copies of the chat history database — the three newest, taken at most twice a day |
| `brain/` | Wiki pages, vectors, ingested sources, code index databases, proposals |
| `providers/` | Provider profiles, encrypted secrets, reported capabilities |
| `models/` | Downloaded model artifacts; voice models under `models/voice/` |
| `voice/` | Python environment for local speech |
| `tools.json` | Per-tool permissions |
| `search.json` | Search provider, fallback chain, API keys |
| `servers.json`, `servers/` | Managed local servers (SearXNG, `llama-cpp`) |
| `skills.json`, `skills/` | Skill enable flags and installed skills |
| `rules.json` | Your standing rules |
| `prompts/`, `prompt-configs/`, `profiles/` | Prompt overrides and portable setup bundles |
| `work-agents.json`, `sub-agents.json` | Agent overrides and sub-agent types |
| `agent-packs/` | Installed agent packs |
| `issues/` | Issue store and taxonomy |
| `scheduler.json`, `scheduler-runs/` | Scheduled jobs and their run history |
| `research/` | Saved research reports |
| `mcp.json`, `mcp/` | MCP server configuration |
| `lsp.json`, `lsp/` | Language server configuration |
| `webhooks.json` | Outgoing webhook configuration |
| `auth/devices.json` | Paired LAN companions — hashes only, never tokens |
| `oauth/` | Encrypted OAuth tokens |
| `updater.json` | Your update channel |
| `appearance.json` | Theme, custom colors, and fonts |
| `browser-profiles/` | Disposable Agent Browser session profiles; tabs are not restored between sessions |
| `logs/` | `diagnostics.jsonl` and `crash.jsonl` |
| `worktrees/` | Git worktrees created for isolated board tasks |
| `workspace/` | **Sandbox** workspace folder (`~/.minnow/workspace`) for chats without a project root |
| `backups/` | Brain wiki backups (created when you export or restore the wiki) |

Some folders in there are scaffolded ahead of the features that fill them and stay empty. That is normal, and nothing needs cleaning up.

Browser preferences live in the `browser` block of `config.json`: whether browser automation is enabled, whether navigation is allowed, the allowed origin patterns, and whether visible preview tabs are restored on boot. Agent Browser tabs use temporary profiles under `browser-profiles/` and are closed with their service, so they are not restored.

One exception: older profiles may still hold a large `sessions/state.json.backup`. It was an earlier backup format, nothing reads it any more, and the `sessions/snapshots/` copies replace it. Minnow leaves it alone — delete it yourself if you want the space back.

## Encrypted secrets

API keys and similar values are encrypted with AES-256-GCM under `.key`. Deleting or rotating that file makes existing secrets permanently unreadable — Minnow will simply show empty fields where your keys were, and you re-enter them.

On Unix the key file is created with owner-only permissions.

## A clean profile

Point `MINNOW_HOME` at an empty directory and launch. You get a fresh Minnow — new setup wizard, no chats, no keys — and your real profile is untouched. Useful for testing a configuration, or for keeping work and personal setups apart.

## Editing files by hand

Everything except the encrypted secrets is plain JSON or markdown. Reading them is fine. Editing them is a recovery tool, not a workflow: Minnow normalizes configuration on load, so an unexpected shape gets replaced with defaults rather than honoured. Change settings through the app where you can.

Brain pages are the exception — they are ordinary markdown and editing them directly is entirely reasonable. Some people keep `brain/` in a git repository.

## Related

- [Privacy and security](privacy-and-security.md)
- [Brain app](../apps/brain.md)
- [Troubleshooting](troubleshooting.md)
