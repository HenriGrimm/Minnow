---
name: supabase-cli
label: Supabase CLI
description: Use the Supabase CLI for local development, hosted projects, migrations, type generation, and Edge Functions.
---

# Supabase CLI

Use `execute_command` in the project workspace. Prefer the project's pinned CLI through its package runner when the repo includes one, or use `supabase` from PATH. Check `supabase --version` and use `supabase projects list --output json` for hosted work. If setup or account sign-in is needed, direct the user to **Settings → External Connections → Supabase**.

- Inspect `supabase/config.toml`, migration files, and repo scripts first. `supabase status` can print keys and connection strings. Filter those fields in the shell before returning output.
- Identify the project ref before linking or doing hosted work. When linking is requested, use the installed CLI's `supabase link --help` and the verified project ref. For migrations, inspect `supabase migration list --help` and preview pending changes with `supabase db push --dry-run` against the intended hosted target.
- Check `--help` for local and remote targeting flags, which vary by CLI version. Confirm the intended environment before applying migrations, resetting databases, or deploying functions. Use the project's existing workflow for local testing and generated types.
- Keep access tokens, database passwords, and service keys out of chat, source control, and command arguments.

[Supabase CLI reference](https://supabase.com/docs/reference/cli/introduction)
