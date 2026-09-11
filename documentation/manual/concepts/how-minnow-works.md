# How Minnow works

Read this page once and most of the product stops needing explanation.

Minnow is three things stacked together:

1. **A workspace-first shell** — a workspaces picker (`#/workspaces`), a left app rail, and a menubar. You choose a folder, then work in **Code** with chat beside your project. The other surfaces support that work; none of them replace it.
2. **A local tool server** on port 9473. It does everything the browser cannot: reading and writing files, running git, spawning terminals, indexing your code, storing your chats, downloading models.
3. **A model you supply.** Minnow never ships weights and has no built-in model. It streams to whatever OpenAI-compatible endpoint you point it at, and is serenely indifferent to whether that endpoint is in your living room or a datacentre.

Everything else — modes, tools, boards, memory — is arrangement on top of those three.

## The loop

When you press Enter, this happens:

1. Minnow builds a **system prompt** from the active mode, your standing rules, the work agent's role, memory retrieved from Brain, and the tool-use guidance for that mode.
2. It sends your history plus the **tool definitions your mode allows** to the model.
3. The model streams a reply. If it asks to call tools, Minnow checks each one against your permissions and either runs it, asks you, or refuses.
4. Tool results go back to the model, which continues. Repeat until it stops calling tools.
5. The finished turn is written to disk.

Two consequences fall out of that loop and explain most surprises:

- **A model with no tool-calling ability can only talk**, which some models will do at length and with great confidence. If tools never fire, the model is the likely cause, not the permission.
- **Every tool result costs context.** Reading a huge file is not free — it competes with your conversation for room in the window.

## Local by default

| Thing | Where it lives |
|-------|----------------|
| Chats and history | SQLite in your Minnow home |
| Brain wiki, memories, vectors | Your Minnow home |
| API keys, tokens, mail passwords | Encrypted with AES-256-GCM in your Minnow home |
| Downloaded models | Your Minnow home |
| Diagnostics and crash logs | Your Minnow home |

Traffic leaves your machine only when you send it somewhere: a cloud model provider you configured, a web search, a page fetch, a Hugging Face download, a webhook you set up. There is no analytics pipeline and no crash reporting service.

The server binds to loopback. Other devices on your network cannot reach it until you explicitly enable LAN access and pair a device — see [Use Minnow from another device](../extend/companion.md).

Full detail: [Privacy and security](../reference/privacy-and-security.md).

## The workspace boundary

File, git, search and terminal tools resolve **under one folder**, not across your whole disk. In normal use that is the **project you opened** from the workspaces picker into Code.

| Surface | Working folder |
|---------|----------------|
| Code (chat included) | The project you opened |
| A board task chat with isolation on | That task's own git worktree |

An attempt to read outside the boundary fails. That is a feature, and it is the single most important safety property in Minnow. You can lift it — **Settings → General → Filesystem access → full** — but then an agent can touch anything your user account can.

Legacy hashes like `#/desktop` redirect to `#/workspaces`. Old `#/app/chat` links land on Code chat.

## Modes decide what exists

A mode is not a personality setting. It swaps the system prompt *and* the tool list.

Plan mode does not merely ask the model to avoid editing your files; the editing tools are not in the payload. Debug mode is the only composer-strip mode that can read local diagnostics.

The shipped **manual** (`minnow_docs_search`, `minnow_docs_read`, `minnow_docs_list`) is available in composer **General** and in the first-run **onboarding** tour. **Build**, **Plan**, and **Debug** do not get `minnow_docs_*`; they rely on your repo and Brain instead.

Choosing a mode is choosing what is possible for that turn.

See [Modes](modes.md).

## Apps are surfaces, not silos

Every surface shares one chat engine, one set of tools, one session store, and one workspace folder at a time. Chat is part of Code, not a separate dock icon. Opening Brain does not start a different assistant; it gives the same assistant a different layout and workflow, still backed by the same sessions.

That is why one surface can hand off to another: an issue in the tracker can be sent to a chat in a chosen mode, a Brain page can be discussed in chat, and a plan document can become a board of tasks worked by agents. Work does not have to be exported anywhere to move between them.

## Agents all the way down

The assistant you talk to is one agent. It can spawn others:

- **Sub-agents** for parallel investigation — a researcher, an explorer — that report back without cluttering your transcript.
- **Board members** for delivery: builders, testers and fixers each working one task on a kanban board.

Each has a role prompt, its own tool allowlist and its own context budget. See [Agents, sub-agents, and packs](../orchestrate/agents.md).

## When the server is not there

Chat, modes and providers work in a plain browser tab without the tool server. Files, git, terminal, persistence and most other tools do not. If a tool reports "not implemented" or "server required", that is what happened. In the packaged app the server is always running.

## Related

- [Modes](modes.md)
- [Tools and permissions](tools-and-permissions.md)
- [Context, memory, and rules](context-and-memory.md)
- [Where your data lives](../reference/configuration.md)
