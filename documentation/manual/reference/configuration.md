# Find your profile and project files

Minnow home is `%USERPROFILE%\.minnow` on Windows and `~/.minnow` on macOS and Linux. If you launch with `MINNOW_HOME`, Minnow uses that directory. Use a new directory for a clean test profile.

| You need | Look in Minnow home |
| --- | --- |
| Chat history and database snapshots | `sessions/` |
| Brain pages and indexes | `brain/` |
| Issues and attachments | `issues/` |
| Preferences and appearance | `config.json` and `appearance.json` |
| Provider connections and model files | `providers/` and `models/` |
| Automation definitions and runs | `scheduler.json` and `scheduler-runs/` |
| Diagnostics | `logs/` |
| Built-in Sandbox workspace | `workspace/` |

Project folders you open live at their own paths. Use the thread card and Terminal to check the active path before recovering or moving files.

Use [Backup and restore](backup-and-restore.md) to move your profile. Back up project repositories and uncommitted worktrees separately. Keep `.key` private and with its encrypted data. Deleting it makes saved credentials unreadable.

Change preferences in Settings. If you need to copy a live database by hand, quit Minnow first, including the process in the tray.
