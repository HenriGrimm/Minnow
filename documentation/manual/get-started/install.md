# Install and first launch

Minnow ships as a normal desktop application. This page covers getting it onto your machine, what happens the first time it opens, and how updates work afterwards.

Once it is running, go straight to [Connect a model](connect-a-model.md) — the interface works without one, but nothing can answer you until a provider responds.

## Download

Get the installer from [Minnow Releases](https://github.com/HenriGrimm/Minnow/releases).

| Platform | What you download |
|----------|-------------------|
| Windows | NSIS installer (`.exe`) |
| macOS | `.dmg`, or `.zip` if you prefer to unzip into Applications yourself |
| Linux | **AppImage** (`Minnow-x.x.x-x86_64.AppImage`) from the same releases page. Make it executable (`chmod +x …`) and run it — no system package manager required. Tray integration may need AppIndicator or StatusNotifier (common on KDE; GNOME may need an extension). Or [build from source](https://github.com/HenriGrimm/Minnow/wiki/Setup-from-source) via the wiki. |

### If Windows blocks the installer

Builds may be unsigned, and SmartScreen will announce that the publisher is unknown. This is true. It is also the most accurate thing Windows will tell you today. Choose **More info**, then **Run anyway** — you should only need to do it once, after which Windows will forget it ever objected.

## What happens on first launch

On a new installation, Minnow opens directly into **setup**. After completing or skipping setup, choose a project folder in the **workspaces picker**, then land in **Code** with chat in the left rail beside your editor.

Two things happen behind the scenes:

- Minnow creates its home folder, `%USERPROFILE%\.minnow` on Windows or `~/.minnow` elsewhere, and scaffolds the folders it uses. Empty directories in there are normal; they are waiting for things that have not happened to you yet. See [Where your data lives](../reference/configuration.md).
- A local tool server starts on port **9473**. It is what lets chat read files, run git, open a terminal, and save your sessions. It listens on loopback only unless you deliberately turn on LAN access.

The **setup wizard** guides you through appearance, a model provider, web search, optional extras, GitHub, tool permissions, and memory. The appearance page includes **Interface zoom** in the desktop app; theme and zoom changes apply immediately. In a browser, use the browser’s zoom controls. You can skip any optional step and run setup again from **Settings → General → Run setup again**. Setup actions stay within the wizard.

Choose **Minnow**, **Cloud API**, **CLI**, or **External Local Server** for models. Minnow can download a model for your hardware or scan an existing model folder and load a GGUF file in place. CLI supports Claude Code, Codex, and Cursor. Enable an installed, signed-in agent, then choose its default model. Install and sign-in actions show commands to run in your own terminal; return to setup and scan or verify after completing them.

**Web search** recommends Tavily. Create a free account at [tavily.com](https://www.tavily.com/), copy an API key from your [dashboard](https://app.tavily.com/), and paste it into setup. Brave, DuckDuckGo, SearXNG, and turning search off are also available. SearXNG is an optional local install. Extras show each service’s status and progress, with technical details available when needed.

## Closing, quitting, and the tray

Closing the window does **not** quit Minnow. By default it hides to the system tray so chats, agents, scheduled jobs and the tool server keep running. That is deliberate: a long agent run should survive you closing the window.

If several workspace windows are open, closing one asks whether to **close that workspace** (stop its chats and agents, and drop the folder from the next launch) or **keep it in the background**. The prompt is the same Minnow dialog used elsewhere in the app. Check **Do this every time** to skip the question until you change **Closing one of several windows** under Desktop app.

The tray menu has Open, New chat, current agent/model status, unload local models, Settings, and launch-at-startup. **Quit Minnow** from the tray does a full shutdown.

Change this under **Settings → General → Desktop app**:

- **Keep Minnow running after closing the window** — on by default; turn it off if you want the close button to quit.
- **Launch Minnow at startup** — off by default; this registers a real OS login item.

## Updates

Packaged builds check GitHub Releases in the background. When a build is downloaded and ready, a **Restart** pill appears in the menubar with the new version.

**Settings → About & troubleshooting → Updates** has the rest: current version, release notes, a manual **Check for updates**, and the channel.

| Channel | What you get |
|---------|--------------|
| **Stable** | Normal releases. The default. |
| **Beta** | Pre-releases as well. Newer features, rougher edges. |

Two things worth knowing: a completed download stays ready even if a later check fails, so a flaky network does not lose your update; and because closing to tray keeps Minnow alive, an update that wants a restart applies when you actually quit and reopen, not when you close the window.

## Quick health check

If something is clearly not working, in order:

1. Is your model provider actually running, with a model loaded?
2. **Models → Providers** — is the base URL right? Press refresh.
3. **Settings → Advanced → Health & diagnostics** — subsystem probes, grouped errors, and a local log tail. **Copy report** produces a redacted markdown summary you can paste into a bug report.

Everything on that page stays on your machine. Minnow sends no telemetry.

More symptoms and fixes: [Troubleshooting](../reference/troubleshooting.md).

## Next

[Connect a model](connect-a-model.md)
