# Back up and restore a Minnow profile

Open **Settings → Data and privacy → Backups**. Back up your project directories and Git worktrees separately. Board recovery can carry source checkpoints in a protected backup. Existing worktree folders still need their own copies.

## Create a backup

1. Select the data to keep, such as chats, Brain, issues, or settings. Downloaded models are optional and can be large.
2. Add a passphrase if you want to include credentials, encryption keys, or encrypted automation settings. Store the passphrase separately from the backup. An unencrypted backup omits credentials and blanks certain secret fields.
3. Choose a destination outside Minnow home and select **Create backup**. Keep the resulting `.mnbak` file somewhere you can reach if the original disk fails.

For recurring copies, enable **Take snapshots automatically**, choose a folder and retention count, and set a snapshot passphrase if needed. Review the last snapshot in Backups and check Activity for errors.

## Restore on this or another computer

1. Choose **Restore from a backup** in startup setup on a new computer, or open **Backups** in an existing profile.
2. Pick the file, supply its passphrase if required, and inspect the preview. Selected categories replace their current data. If the backup brings a different encryption key, read the credential impact shown in the preview.
3. Apply the restore and restart when prompted. Confirm that the expected chats, issues, or notes are present. Verify your provider connections and reopen any project folders you moved separately.
4. If the result is wrong, use **Undo restore** and restart. **Delete previous data** frees the retained copy once you have verified the restore.

If Minnow reports damage or a bad passphrase, verify that you copied the full file and retry with the original passphrase. Keep room on disk to unpack the backup alongside the current profile.
