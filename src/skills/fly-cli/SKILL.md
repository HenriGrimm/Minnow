---
name: fly-cli
label: Fly.io CLI
description: Use the authenticated Fly.io CLI to inspect apps, logs, machines, releases, and deploy projects on Fly.io.
---

# Fly.io CLI

Use `execute_command` in the project workspace. Check `fly version` and `fly auth whoami`. Some installs provide `flyctl` instead, with the same subcommands. If the CLI or sign-in is missing, ask the user to open **Settings → External Connections → Fly.io**, then retry the check.

- Read `fly.toml` and identify the app before running app commands. Use `fly apps list` to discover accessible apps, and `fly status -a APP`, `fly releases -a APP`, or `fly logs --no-tail -a APP` to inspect a specific app.
- For deployment work, validate the config with `fly config validate`. When deployment is in scope, use `fly deploy -a APP` for the verified app and check the resulting status. For an undeployed project, inspect `fly launch --help` before creating any resources.
- Verify the target before changing machines, capacity, or secrets. Use secret names and status in reports and keep values out of command arguments and chat output.

Check the installed command's `--help` for version-specific flags. [Fly.io CLI docs](https://docs.fly.io/flyctl/)
