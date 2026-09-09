# Releasing Minnow

How updates flow through Minnow — **releasing** a new version (for maintainers) and
**receiving** one (for users). Auto-update is built on
[`electron-updater`](https://www.electron.build/auto-update) against **GitHub Releases**
([`henrigrimm/minnow`](https://github.com/henrigrimm/minnow)). Implementation: [`electron/updater.ts`](../../electron/updater.ts) +
[`electron/updater-core.ts`](../../electron/updater-core.ts); UI in
[`src/ui/settings-updates.ts`](../../src/ui/settings-updates.ts) and
[`src/os/update-menubar.ts`](../../src/os/update-menubar.ts). Tracked in
[MIN-384](https://linear.app/minnowai/issue/MIN-384).

> **Platform support today:** Windows (NSIS), Linux (AppImage), and **signed** macOS (Developer ID + notarization). Unsigned macOS installs show a disabled updater with a signing note. On Windows/macOS hosts, build Linux with `npm run package:linux:docker` (Docker). Dev and browser sessions can't self-update and show a hint instead of controls.

---

## Part 1 — Releasing a new version (maintainers)

Packaging **never uploads anything** (`electron-builder` runs with `--publish never`); you
create the GitHub release by hand. The `build.publish` config in
[`package.json`](../../package.json) exists only so packaging emits the `latest.yml` feed
file. Four steps:

### 1. Bump the version

Edit `version` in [`package.json`](../../package.json):

```jsonc
{
  "version": "1.0.1"   // was 1.0.0
}
```

**This is mandatory for every release.** An installed app decides whether to update by
comparing its own version against the one in `latest.yml`. If you don't bump, nobody
upgrades. Use [semver](https://semver.org/): patch for fixes, minor for features.

### 2. Package

```bash
npm run package
```

This runs `build → electron:build → electron-builder` and writes to `release/pkg/`:

| File | Role |
|------|------|
| `Minnow-Setup-<version>.exe` | The NSIS installer users download (Windows). |
| `latest.yml` | **Windows update feed.** Version + SHA512 hashes; `electron-updater` fetches this to detect a new build. |
| `Minnow-Setup-<version>.exe.blockmap` | Enables smaller delta downloads between versions. |
| `Minnow-<version>-x86_64.AppImage` | Linux portable install (`npm run package:linux` or `package:linux:docker` on Windows/macOS). |
| `latest-linux.yml` | **Linux update feed** — attach alongside the AppImage. |

### 3. Create the GitHub release

On <https://github.com/henrigrimm/minnow/releases> → **Draft a new release**:

- **Tag:** `v<version>` (e.g. `v1.0.1`), created against the commit you packaged from.
- **Attach platform artifacts** from `release/pkg/` (Windows) and `release/pkg-linux/` when you
  built Linux via Docker. At minimum per platform: installer/binary + matching feed (`latest.yml`
  on Windows, `latest-linux.yml` on Linux) + `.blockmap` where electron-builder emits one.
  Without the feed file, installed apps never see the release.
- **The feed and the installer must be from the same build.** `electron-updater` hashes the
  downloaded `.exe` / AppImage / zip against `sha512` + `size` in the YAML. Replacing an
  installer on an existing tag without replacing that platform’s `latest*.yml` looks like
  “it downloaded but will not install.” After attaching assets, run
  `node scripts/verify-github-update-feed.mjs`.
- **Publish the release** (do not leave it as a **draft**). Draft releases are invisible to
  `electron-updater`; Settings will show **Could not check for updates** until the release is
  published.
- **Release notes / body:** this text is what users see under **"What's new"** in Settings
  and in the menubar popover. Write it for users, not as a changelog dump.

### 4. Pick the channel

The **pre-release** checkbox on the GitHub release is the channel switch:

| GitHub setting | Who receives it |
|----------------|-----------------|
| **Latest release** (pre-release unchecked) | Everyone on the **Stable** channel. |
| **Pre-release** (checkbox checked) | Only users who selected the **Beta** channel. |

Beta rides GitHub pre-releases via `autoUpdater.allowPrerelease` — there's no separate
beta feed to maintain.

### Release checklist

```
[ ] Bumped version in package.json (and committed)
[ ] npm run package:win (and package:linux or package:linux:docker) succeeded
[ ] release/pkg/ has .exe + latest.yml + .blockmap; Linux AppImage + latest-linux.yml if shipping Linux
[ ] GitHub release tagged v<version>
[ ] All platform feed files and installers attached
[ ] Release notes written for users
[ ] Pre-release flag set correctly (unchecked = Stable, checked = Beta)
```

### Signing caveat (Windows)

Builds are **unsigned**, so the *first manual install* of the `.exe` may trigger a
SmartScreen warning ("More info → Run anyway"). Auto-updates after that first install are
silent — the user doesn't re-clear SmartScreen on every update.

---

## Part 2 — Receiving updates (users)

Automatic and calm by design. On a packaged Windows install:

### The automatic flow

1. **Check.** 15 seconds after launch, then every 4 hours, the app fetches `latest.yml`
   and compares versions. Launch is never blocked on this.
2. **Download.** A newer version downloads in the background automatically — no prompt, no
   interruption.
3. **Install on your terms.** Click **Restart to update** when you're ready. If you never
   do, the update installs automatically the next time you quit Minnow normally.

### Where you see it

**Menubar pill** (left of the settings gear) — silent unless there's something to act on:

| State | Pill |
|-------|------|
| Up to date | Hidden — zero noise. |
| Downloading | `↓ 67%` |
| Ready | Accent **`Restart · 1.0.1`** — click for a popover with release notes, **Restart now** / **Later**, and a link to Settings. |

**Settings → General → App updates** — the full picture and all manual controls:

- **Status strip:** up to date / checking / downloading % / ready / couldn't check.
- **Installed version**, **Last checked**, **Next automatic check**.
- **Update channel:** Stable / Beta toggle.
- **Check for updates** button (manual check).
- **Restart to update** button (appears when a build is ready).
- **What's new** expander with the release notes.

### Switching channels

Toggle **Stable ↔ Beta** in Settings → General → App updates. No reinstall — the choice
persists to `~/.minnow/updater.json` and triggers an immediate re-check. Beta simply opts
you into GitHub pre-releases, which may be less stable; switch back anytime.

### What happens on failure

Deliberately quiet:

- **Background check fails** (offline, GitHub unreachable) → silent, logged, retried next
  cycle. No toasts.
- **You click "Check for updates" and it fails** → an inline error in the status strip
  (the only place failures surface, since you asked).
- **A download is interrupted** → retried on the next cycle; a build that already finished
  downloading stays "ready" and is never lost to a later failed check.

---

## Testing the full loop

The complete "old install upgrades itself" path can only be exercised once **two** versions
exist on GitHub Releases. The practical first validation:

1. Release `1.0.1`, install it.
2. Release `1.0.2`.
3. Launch the `1.0.1` install and confirm it detects `1.0.2`, downloads, shows the menubar
   pill, and installs on restart.

Unit coverage for the state machine and UI lives in
[`test/electron/updater-core.test.mts`](../../test/electron/updater-core.test.mts),
[`test/settings/settings-updates.test.mts`](../../test/settings/settings-updates.test.mts),
and [`test/os/update-menubar.test.mts`](../../test/os/update-menubar.test.mts).

---

## Reference

| Concern | Where |
|---------|-------|
| Updater controller (schedule, download, install) | [`electron/updater.ts`](../../electron/updater.ts) |
| State machine (pure, testable) | [`electron/updater-core.ts`](../../electron/updater-core.ts) |
| IPC channels (`minnow:updater:*`) | [`electron/ipc-channels.ts`](../../electron/ipc-channels.ts) |
| Renderer bridge + display helpers | [`src/electron/updater-client.ts`](../../src/electron/updater-client.ts) |
| Settings UI | [`src/ui/settings-updates.ts`](../../src/ui/settings-updates.ts) |
| Menubar pill + popover | [`src/os/update-menubar.ts`](../../src/os/update-menubar.ts) |
| Persisted channel choice | `~/.minnow/updater.json` |
| Publish config (`--publish never` locally) | [`package.json`](../../package.json) `build.publish` + [`scripts/electron-builder-run.mjs`](../../scripts/electron-builder-run.mjs) |
| Packaging targets, extra resources, asar unpack | [`package.json`](../../package.json) `build` + [`context.md`](../context.md#electron-and-packaging) |
| macOS signing & notarization | [`macos-signing.md`](macos-signing.md) |
