# Research

Research is for questions that deserve more than one search. You describe what you want to know; an agent runs several rounds of searching, opening pages, extracting what matters and synthesizing — then writes you a report with sources.

Use chat for "what is the syntax for X". Use Research for "compare these four libraries and tell me which fits our constraints".

Open it from the app rail.

## Running a search

Type your question into the **Research question** box. Be specific — the engine uses your framing to decide what to look for and when it has enough.

Then set the run up:

| Control | What it changes |
|---------|-----------------|
| **Rounds** | Auto, or a fixed 1–5. Auto stops when the answers stop improving. |
| **Scope** | **Web**, **Codebase**, or **Web + Codebase** |
| **Workspace** | Which repository to search, when the scope includes code |
| **Category** | Auto, Technical, Academic, News, Market, General — shapes source selection |
| **Search** | Override the search provider for this run (engine chip) |
| **Model** | On the composer bar: same picker as Code — binds the **active chat** for this run (Settings → Deep Research model applies when unset) |

The sparkles control beside **Research** expands your draft into a fuller question in place before you start. Press **Research**. A progress stepper shows each round as it happens; **Cancel** stops it.

**Codebase scope is underrated.** "How does authentication flow through this repo?" against Web + Codebase gives you an answer grounded in your actual code and in what the libraries you use are documented to do.

## What the engine does

Each round: search, choose the most promising pages, fetch and extract their content, and fold the findings into a running synthesis. It stops when it has enough, hits the round cap, or runs out of new material.

Defaults, all adjustable under **Settings → Integrations → Deep Research**:

| Setting | Default |
|---------|---------|
| Minimum rounds | 3 |
| Maximum rounds | Auto |
| Time budget per run | 300 s (hard run timeout 1800 s) |
| URLs opened per round | 3 |
| Content kept per page | 15,000 characters |
| Extraction concurrency | 3, with a 90 s timeout |
| Final report size | up to 16,384 tokens |

Raise rounds and URLs per round for breadth. Raise the report token cap when reports come out truncated. Lower the time budget if you want answers faster and shallower.

Research can use a different model than your chat — bind one under the same settings section, or override it per run. This is a good place to spend a cloud model: synthesis quality across many sources is exactly what large models are better at.

## The library

Save a finished report and it goes into the **Library**.

| Action | Why |
|--------|-----|
| **Save** | Keep the report; runs are not retained automatically |
| **Re-open** | Read it again without paying for the run twice |
| **Discuss** | Continue in chat with the report as context |

**Discuss** is the one people miss. It turns a static report into a conversation: "which of these did you say has the licensing problem?" — with the full report in context.

Reports you want to keep for a long time belong in [Brain](brain.md), not the library. Ask the assistant to write the conclusions to a Brain page and they become retrievable memory instead of an archived document.

## Search providers

The default is **SearXNG**, which Minnow provisions and runs locally on port 8899 — including its own standalone Python — so search works out of the box without an account. If it is unavailable, the fallback chain tries Tavily, then Brave, then DuckDuckGo.

Change the provider under **Settings → Integrations → Search**. DuckDuckGo needs no key; Brave and Tavily do. Manage the local SearXNG process under **Settings → Integrations → Servers**.

## Safety

Text extracted from web pages is wrapped in untrusted-content fences before it reaches the model. Instructions hidden in a page arrive as quoted material, not as commands. See [Privacy and security](../reference/privacy-and-security.md).

Research means fetching pages, so the sites you research do see requests from your machine.

## Related

- [Brain app](brain.md)
- [Settings app](settings.md)
