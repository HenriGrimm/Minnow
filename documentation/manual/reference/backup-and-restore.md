# Backup and restore

Everything you own in Minnow lives in one folder, and the key that protects your credentials sits in that same folder. A disk failure takes both. Backup writes the parts worth keeping into one file you can put somewhere else, and restore brings them back — on this computer or a new one.

Find it under **Settings → General → Backup and restore**.

## What goes into a backup

You choose by category. The selection is saved and used for both manual backups and scheduled snapshots.

| Category | Contains | Default |
|----------|----------|---------|
| **Settings and preferences** | Preferences, appearance, tool permissions, provider profiles, MCP and language servers, prompts, rules, agents | On |
| **Credentials and encryption key** | API keys, sign-in tokens, connection secrets, scheduled-job prompts, and `.key` | On — needs a passphrase |
| **Chats and usage history** | Every conversation, sub-agent transcripts, plan drafts, usage statistics | On |
| **Brain and memory** | Wiki pages, memories, ingested sources, search vectors | On |
| **Issues and reviews** | The issue tracker with attachments and taxonomy, in-app pull request reviews | On |
| **Boards** | Orchestrate board journals and run transcripts | On |
| **Scheduled jobs** | Scheduler jobs and run history | On |
| **Skills, plugins and agent packs** | Installed skills, plugin packages and their data, agent packs | On |
| **Sandbox files** | Files in the Sandbox workspace | On |
| **Other saved data** | Saved reports and run history from the rest of Minnow | On |
| **Downloaded models** | Model files | Off — large, and re-downloadable |

The size beside each category is what it holds right now, before compression.

### What is never backed up

Logs, caches, screenshots, browser profiles, git worktrees, installed language servers, managed servers, the local speech environment and model runtimes. They are either regenerated on demand or downloaded again, and together they are usually many times larger than everything above. Brain's code indexes are in the same group: they are rebuilt from your projects.

Dependency folders inside the Sandbox workspace (`node_modules`, `.venv`) are skipped for the same reason.

## Passphrases and credentials

A passphrase is optional. It decides two things at once.

**With a passphrase** the backup is encrypted (AES-256-GCM, with a key derived from your passphrase by scrypt) and it can carry your credentials, including `.key`. Restore it on a new computer and your API keys work without re-entering anything.

**Without a passphrase** the backup is not encrypted, so Minnow leaves the secrets out:

- `.key` and every file encrypted with it are omitted — provider keys, sign-in tokens, connection secrets, and scheduled jobs, whose prompts are encrypted.
- Secrets that Minnow stores as plain text — search API keys, MCP server environment variables and request headers — are blanked in the copy that goes into the backup.

This is not negotiable from the UI, and the reason is simple: `.key` beside the data it unlocks, in a file anyone can read, protects nothing.

Minnow cannot recover a passphrase. It is not stored anywhere for manual backups. Lose it and that backup is unreadable.

## Back up now

1. Check the categories you want.
2. Type a passphrase twice, or leave both fields empty.
3. Pick a folder. An external drive or a synced folder is the point of the exercise; a folder inside the Minnow home is refused.
4. **Create backup.**

You get one file named `minnow-backup-<date>_<time>.mnbak`. It is safe to run while you work: chat history and other databases are copied through SQLite's backup mechanism, so the copy is consistent even while a chat is streaming.

## Scheduled snapshots

Turn on **Take snapshots automatically** and choose daily or weekly, a folder, and how many to keep.

- Snapshots are named `minnow-snapshot-<date>_<time>.mnbak`. Only files with that name are rotated; a manual backup in the same folder is never deleted.
- A snapshot is skipped when nothing has changed since the last one.
- Snapshots run while Minnow is running, including when it is in the tray. If Minnow was closed when one was due, it runs a few minutes after the next start.
- **Snapshot passphrase** works like the manual one: set it and snapshots are encrypted and include credentials; leave it unset and they are plain and leave credentials out. Because snapshots run unattended, this passphrase is saved — encrypted with `.key`, like your other secrets. Write it down somewhere else: you need it to restore, and a dead disk takes the saved copy with it.
- **A failed snapshot is never silent.** It raises a notification in the bell and shows its reason in Settings. Minnow retries after an hour, then after six, then at the normal interval.

## Restore

**Restore from a backup…** lists the backups in a folder. You can also paste the path of a single `.mnbak` file.

Choosing one shows a preview before anything happens: when it was made, by which version, how large it is, whether it is encrypted, and what it contains. Untick anything you do not want back. An encrypted backup asks for its passphrase.

Then:

1. Minnow unpacks the backup beside your data and checks it — every file against its checksum, every database for integrity. A damaged or tampered backup stops here, with your data untouched.
2. You restart Minnow. The swap happens at startup, before anything is opened.
3. Each restored category replaces what was there. **What was there is moved aside, not deleted**, into `pre-restore/` inside the Minnow home.

Until you restart, **Cancel restore** drops the whole thing.

### What a restore leaves alone

- Categories you did not select, and categories the backup does not contain.
- Anything a backup never carries: models you did not back up, caches, logs, worktrees, Brain's code indexes.
- **Your credentials, when the backup has none.** Restoring an unencrypted backup keeps the keys already on this computer, and fills the blanked plain-text keys back in from your current settings. On a new computer there is nothing to keep, so you enter them again.

### When the backup carries a different encryption key

A backup from another computer brings that computer's `.key`. Encrypted files on this computer that the backup does not replace cannot be opened with it, so they are moved aside with the rest of the previous data rather than left to fail. The preview tells you when this applies.

### Undo

After a restore, Settings shows what was restored and how much previous data is being kept.

- **Undo restore** puts the previous data back at the next start.
- **Delete previous data** frees the space. After that the restore cannot be undone.

### Restoring on a new computer

Install Minnow, and on the first screen of setup choose **Restore from a backup**. Pick the file, enter the passphrase if it has one, and restart when asked. Setup is skipped once the restore is in place, because your settings arrive with it.

## Versions

A backup records the Minnow version that made it.

- **Older backup, newer Minnow** — fine. Its data is upgraded the first time Minnow starts after the restore, the same way it would have been by updating.
- **Newer backup, older Minnow** — the preview warns you. Update Minnow first; parts it does not recognise are skipped.

## If something goes wrong

| What you see | What it means |
|--------------|---------------|
| *Wrong passphrase, or this backup is damaged* | The passphrase does not open the file. Nothing was changed. |
| *Backup is damaged / incomplete* | The file was cut short or altered — an interrupted copy, usually. Nothing was changed. |
| *Not enough free disk space to unpack this backup* | Restore needs room for the unpacked backup next to your existing data. |
| *The restore could not be applied* after a restart | Something held a folder open. Your data is back as it was; Minnow tries again on the next start, and stops after three attempts so you can decide. |
| *The snapshot folder is not available* | The drive is unplugged or the synced folder is signed out. The next retry picks it up. |

## Related

- [Where your data lives](configuration.md)
- [Privacy and security](privacy-and-security.md)
- [Settings](../apps/settings.md)
