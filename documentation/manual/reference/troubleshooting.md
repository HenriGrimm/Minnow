# Troubleshooting

Symptoms and fixes, roughly in the order people hit them. Paths refer to the in-app **Settings** app.

## Start here

Before anything else, open **Settings → Advanced → Health & diagnostics**. It probes each subsystem, groups recent errors, and tails the local log. **Copy report** produces a redacted markdown summary — attach it to a bug report rather than describing the symptom from memory.

Nothing on that page is transmitted. Minnow sends no telemetry.

## Nothing answers me

| Symptom | Fix |
|---------|-----|
| Model picker is empty | Is the provider running with a model loaded? Is the base URL right, including `/v1` where required? Press refresh in **Models → Providers**. |
| `[providers] fetch failed` at startup | Normal when LM Studio or Ollama is not up yet. Start it and refresh. |
| Replies are empty or garbled | The endpoint may not speak standard `/v1/chat/completions` SSE. Try another model or provider profile. |
| Replies stop mid-sentence, forever | A stalled upstream stream. **Settings → Agents → Watchdog** sets the idle timeout that catches this. |
| Chat works but tools never run | Use a tool-calling-capable model; check the tool is enabled and not **Off** in **Settings → Integrations → Tools**; check your mode allows it. |
| Images are ignored | You need a vision model. Text-only models silently drop image parts. |

## Tools and files

| Symptom | Fix |
|---------|-----|
| Cannot read a file outside the project | By design — file and git tools stay under the workspace root. Change it in **Settings → General → Filesystem access** if you genuinely need full disk. |
| A tool says it needs the server | That tool runs server-side. In the packaged app the server is always up; check Health & diagnostics. |
| Web search does nothing | **Settings → Integrations → Search**. The default SearXNG runs locally — check it under **Servers**. Or switch to DuckDuckGo, which needs no key. |
| `browser_*` tools missing | Browser automation needs the Electron desktop app. |
| Browser navigation blocked | Only localhost is allowed by default. Add the origin under **Settings → Integrations → Browser**, or approve when asked. |
| Approval strip never appears, tool just runs | That tool is on **Full**. Probably from pressing **2** once. |
| PDF or Office attachment fails | The parsers are optional dependencies. Packaged builds include them; in a source clone, re-run `npm install` without `--no-optional`. |

## The model forgets things

Look at the context ring first. When it is near full, the model is losing the earliest parts of your conversation.

| Fix | Cost |
|-----|------|
| New chat for the new subtask | Lowest — usually the right answer |
| Remove large attachments | Low |
| Save durable facts to Brain, then start fresh | Low, and they come back through retrieval |
| Larger-context model | Depends on your hardware |

If the ring shows no cap, the model did not report a context length. See [Context, memory, and rules](../concepts/context-and-memory.md).

## Agents and boards

| Symptom | Fix |
|---------|-----|
| A board task sits doing nothing | A tool is probably on **Ask** with nobody to approve it. Check permissions before AFK runs. |
| Task quarantined | It exhausted its retries. Open the task chat to read what happened, fix the cause, then **Requeue**. |
| Board never starts | Is the workspace a git repository? Boards need one. Minnow offers to set it up during board creation. |
| Parallel tasks conflicting | Turn worktree isolation on. Auto and AFK use per-task worktrees by default. |
| Sub-agent seems stuck | The agent activity panel shows live phase and current tool. Timeouts are per type in **Settings → Agents → Sub-agents**. |
| Undo control is missing | It only appears in a git repository, and only when that turn changed files. The message **⋮ → Undo turn** still does a chat-only rewind. |

## Scheduler

| Symptom | Fix |
|---------|-----|
| Job never ran | Minnow must be running — tray counts, quit does not. Is the job enabled? Is the interval at least 60 s? |
| Job ran but did nothing | Tools on **Ask** stall with nobody to approve them |
| Job failed | Read the run history message. Does the model still exist? Does the workspace path still exist? |
| Wrong files touched | The workspace set on the job |

## Voice

| Symptom | Fix |
|---------|-----|
| Speech fails | Choose **Built-in** dictation and **System voice** in **Models → Voice**. Built-in dictation needs internet for its first model download. Check microphone permission and system voice availability. Advanced local models use the optional Python runtime. |
| Dictation hears my speakers | **Settings → General → Audio** — turn on echo cancellation |
| No microphone on the LAN companion | Plain HTTP is not a secure context; browsers block capture there |

## Updates and install

| Symptom | Fix |
|---------|-----|
| No update pill | You may be current. **Settings → General → App updates → Check for updates**. |
| Download seems stuck | Wait for the next automatic cycle or check manually. A completed download stays ready even if a later check fails. |
| Update does not apply | Closing the window hides to tray. Quit properly from the tray menu. |
| SmartScreen warning | Expected for unsigned Windows builds: **More info → Run anyway**, once. |

## Data and secrets

| Symptom | Fix |
|---------|-----|
| All my API keys vanished | `.key` was deleted or rotated. Restore it from backup, or re-enter the keys. |
| Want a clean profile | Point `MINNOW_HOME` at an empty folder and launch. Your real profile is untouched. |
| Want to remove everything | Delete your Minnow home. Uninstalling deliberately leaves it in place. |

## Still stuck

Take **Copy report** from Health & diagnostics and open a [GitHub issue](https://github.com/HenriGrimm/Minnow/issues). It includes version, platform and recent errors with paths and secrets redacted, which is most of what anyone will ask you for.

## Related

- [Where your data lives](configuration.md)
- [Tools and permissions](../concepts/tools-and-permissions.md)
- [Connect a model](../get-started/connect-a-model.md)
