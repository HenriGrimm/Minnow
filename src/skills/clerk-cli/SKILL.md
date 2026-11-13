---
name: clerk-cli
label: Clerk CLI
description: Use the Clerk CLI to inspect applications, link projects, diagnose authentication setup, and manage Clerk configuration.
---

# Clerk CLI

Use `execute_command` in the project workspace. Run `clerk --version` and `clerk whoami --mode agent --json` for account-based work. If the CLI or sign-in is missing, direct the user to **Settings → External Connections → Clerk**. Let the user complete interactive OAuth.

- Inspect the project's framework, Clerk dependencies, and existing application link first. Use `clerk apps list --mode agent --json` to identify an account app and `clerk doctor --mode agent --json` to diagnose the integration.
- Use the installed command's `--help` to check flags. When requested, use `clerk link` to associate an existing app or `clerk init` to set up Clerk in a project. Review which files and dependencies changed. On supported frameworks, accountless init can create an unclaimed development app, so identify the intended app before initializing.
- Verify both the app and instance before changing authentication settings or running production commands. When a project or environment has its own Clerk key, check which target the command will use. `clerk env pull` writes keys to a local env file. Review the file path and ignore rules without printing its contents.

[Clerk CLI docs](https://clerk.com/docs/cli)
