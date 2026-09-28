# Connect a model

Minnow does not ship a model. It speaks the **OpenAI-compatible** chat API, which means it can talk to almost anything: a local runtime on your own machine, a model Minnow downloads and serves for you, or a cloud API you pay for. You need at least one, and you can have several at once.

Everything on this page lives in the **Models** app. Open it from the app rail.

## Pick your route

| You want… | Do this |
|-----------|---------|
| To use a runtime you already have | [LM Studio](#lm-studio) or [Ollama](#ollama) |
| Minnow to handle downloading and serving | [Serve a model inside Minnow](#serve-a-model-inside-minnow) |
| Frontier-quality answers, no local hardware cost | [Cloud APIs](#cloud-apis) |

Mixing is normal and often the right answer: a small fast local model for routine turns, a cloud model bound to the roles that need real reasoning. See [Routing](#routing-which-model-does-what).

## LM Studio

1. Install and open [LM Studio](https://lmstudio.ai/).
2. Download a chat model and **load** it.
3. Open the **Developer** / **Local Server** tab and start the server. The default is `http://localhost:1234`.
4. In Minnow: **Models → Providers**. If LM Studio is already running on its default port, Minnow detects it. Otherwise add the base URL yourself.
5. Refresh the provider, then pick a model from the menubar model chip.

Seeing `[providers] fetch failed` in a log at startup is normal when LM Studio is not running yet. Start the server and refresh.

## Ollama

1. Install [Ollama](https://ollama.com/) and pull a model (`ollama pull …`).
2. Ollama exposes an OpenAI-compatible API at `http://localhost:11434/v1`.
3. In **Models → Providers**, add or confirm a provider with that base URL, then refresh.

As with LM Studio, Minnow registers Ollama automatically when it is already listening on the default port.

## Serve a model inside Minnow

If you would rather not run a separate app, Minnow can do the whole job.

- **Recommendations** probes your actual hardware — CPU, RAM, GPU, VRAM — and scores models by how well they will fit. Start here if you do not know what your machine can handle.
- **Library** searches Hugging Face and downloads weights into `models/` under your Minnow home.
- **Serve** starts the bundled `llama-server` against a downloaded model and registers the running server as a provider automatically. It appears in the model picker with no extra setup.
- **Installed** lists what you have downloaded, so you can free disk space later.

Model files are large. Minnow keeps them out of the settings backup path deliberately — see [Where your data lives](../reference/configuration.md).

## Cloud APIs

Any OpenAI-compatible HTTPS endpoint works. **Models → Providers** has one-click presets for common services — OpenCode Go/Zen, Anthropic, DeepSeek, GitHub Copilot, OpenRouter, OpenAI, Groq, Mistral — plus a custom option where you supply a base URL yourself.

API keys are **encrypted at rest** with AES-256-GCM under a key file in your Minnow home. If you lose that key file, the keys cannot be decrypted and you re-enter them. Read [Privacy and security](../reference/privacy-and-security.md) before you paste a key you care about.

Using a cloud provider means your prompts go to that provider. That is the one case where Minnow's local-first default does not apply, and it applies only to the traffic you direct there.

## Choosing the model for a turn

There are two different pickers, and confusing them causes a lot of "why is it using the wrong model?" confusion:

| Control | Scope |
|---------|-------|
| **Menubar model chip** | The global default — what new chats start with |
| **Composer picker / Ctrl+M / Cmd+M** | This chat only |

The list is whatever your enabled providers report on refresh. If it is empty, the provider is not reachable or has no model loaded.

Local runtimes usually expose **Load** / **Unload** controls in the composer picker, which act on the model that chat is bound to — not the global default.

## Routing: which model does what

**Models → Routing** binds models to *roles* instead of making one model do everything. The shared **Utility tasks** binding covers chat titles, prompt and issue expansion, and git commit messages. Leave it unset to use each task's current composer, top-bar, or editor model. Evaluation, research, planning, review, and board work keep their own bindings.

Two neighbouring sections shape how models behave:

- **Sampler** — temperature, top-p, top-k, min-p, penalties, max tokens. Defaults are tuned to avoid the repetition-loop failure mode common in local models; change them only if you know what you are chasing.
- **Thinking** — reasoning mode and budget for models that expose it.

**Usage & cost** tracks token totals and, if you enter per-million pricing, what it cost you.

## Fallbacks

If a provider dies mid-conversation, a fallback chain can retry the next provider — but only before the first byte of the response arrives, so a stream that has already started is never silently swapped underneath you.

## When the picker stays empty

1. Is the provider process actually running?
2. Is a model loaded in it? Minnow lists only what the provider reports.
3. Is the base URL right, including `/v1` where the provider requires it?
4. Press refresh in **Models → Providers**.

If replies arrive empty or garbled, the endpoint is probably not speaking standard `/v1/chat/completions` SSE. Try a different model or provider profile.

## Next

[Your first chat](first-chat.md)

## Related

- [Models app](../apps/models.md) — the full tour of all ten sections
- [Voice](../extend/voice.md) — speech-to-text and text-to-speech models
- [Troubleshooting](../reference/troubleshooting.md)
