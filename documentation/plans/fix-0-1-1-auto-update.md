# Fix v0.1.1 auto-update install + local 0.0.5 version

**Status:** GitHub `latest.yml` re-uploaded; Windows feed now matches Setup.exe  
**Area:** Electron updater, packaging, Settings About/Updates

## Cause

1. **Windows update downloads then fails:** published `latest.yml` (6 Sep, size `286318098`) does not match `Minnow-Setup-0.1.1.exe` (7 Sep, size `286315565`). `electron-updater` verifies SHA-512 after download and rejects the file, so Restart never gets a valid installer.
2. **Local build shows 0.0.5:** `npm start` launches `node_modules/electron/dist/electron.exe` whose Windows version resource was last stamped `0.0.5`. There is no `electron/dist/package.json`, so `app.getVersion()` falls back to that exe metadata. Packaged `Minnow.exe` is already `0.1.1`.

## Todos

- [x] Confirm GitHub Windows feed vs installer (size/hash)
- [x] Sync unpackaged `app.getVersion()` via `electron/dist/package.json` stub (not branded `electron.exe`)
- [x] Let `electron-updater` install on quit (`app.quit()` instead of `app.exit(0)`)
- [x] Read diagnostics version from disk (not Node `require` cache)
- [x] Add a feed-vs-asset size check so mismatched `latest.yml` cannot ship unnoticed
- [x] Update `documentation/context.md` and releasing notes
- [x] Re-upload a matching `latest.yml` on the v0.1.1 GitHub release (needs SHA-512 of the live Setup.exe)
