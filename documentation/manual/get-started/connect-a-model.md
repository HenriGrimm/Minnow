# Connect a model

Minnow does not ship model weights. Connect a local runtime, download and serve a model inside Minnow, add a cloud API, or use an installed agent CLI. You need at least one connection, and you can have several at once.

Everything on this page lives in the **Models** app. Open it from the app rail.

## Pick your route

| You want… | Do this |
|-----------|---------|
| To use a runtime you already have | [LM Studio](#lm-studio) or [Ollama](#ollama) |
| Minnow to handle downloading and serving | [Serve a model inside Minnow](#serve-a-model-inside-minnow) |
| Frontier-quality answers, no local hardware cost | [Cloud APIs](#cloud-apis) |
| An installed Claude Code, Codex, or Cursor CLI | [Agent CLIs](#agent-clis) |

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
2. Ollama exposes an OpenAI-compatible API at `http://localhost:11434`.
3. In **Models → Providers**, add or confirm a provider with that base URL, then refresh.

As with LM Studio, Minnow registers Ollama automatically when it is already listening on the default port.

## Serve a model inside Minnow

If you would rather not run a separate app, Minnow can do the whole job.

- **Discover → Recommended** estimates memory use from your CPU, RAM, GPU, and selected context. Start here if you do not know what your machine can handle.
- **Discover → Hugging Face** searches repositories. Inspect a model's files, choose a quantization, and download it. Pause and resume transfers from the Downloads shelf.
- **My models** lists downloaded weights. Open a model's inspector to load it with llama.cpp, or MLX on Apple Silicon. Minnow registers the running model as a provider.
- **Local Server** shows loaded models, runtime status, and logs. **Storage** manages model folders and Hugging Face credentials.

Model files are large and excluded from backups by default. See [Backup and restore](../reference/backup-and-restore.md).

## Cloud APIs

Any OpenAI-compatible HTTPS endpoint works. **Models → Providers** has one-click presets for common services — OpenCode Go/Zen, Anthropic, DeepSeek, GitHub Copilot, OpenRouter, OpenAI, Groq, Mistral — plus a custom option where you supply a base URL yourself.

API keys are **encrypted at rest** with AES-256-GCM under a key file in your Minnow home. If you lose that key file, the keys cannot be decrypted and you re-enter them. Read [Privacy and security](../reference/privacy-and-security.md) before you paste a key you care about.

Using a cloud provider, including a cloud-connected agent CLI, sends prompts and context to that provider. See [Privacy and security](../reference/privacy-and-security.md) for other network services and permissions.

## Agent CLIs

Open **Models → CLIs**, scan for installed **Claude Code**, **Codex**, or **Cursor CLI**, then expand a row and enable it. If it is missing, **Install** opens the vendor installer in Minnow Terminal. Use **Sign in** and **Verify** to connect your vendor account.

The CLI's models appear in the normal picker and can be assigned to chats and work agents. Minnow applies its mode restrictions and tool permissions to their tool calls. Vendor account requirements, model access, and usage limits apply. Background helper tasks are off by default for CLI connections.

See [Models → CLIs](../apps/models.md#clis) for supported CLI versions, conversation persistence, and usage displays.

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

## Model routers

**Models → Routers** groups models from My models and configured providers. Set each entry's concurrent slots, then select the router in the normal model picker. A chat keeps its assigned model while that model remains available; failures can move it to another entry.

Router failover clears a failed partial reply before starting the replacement response. Local models can load on demand. Use **Default for new chats** to select a workspace default without changing existing chats.

See [Models → Routers](../apps/models.md#routers) for capacity, overrides, and failover behavior.

## When the picker stays empty

1. Is the provider process actually running?
2. Is a model loaded in it? Minnow lists only what the provider reports.
3. Is the base URL right, including `/v1` where the provider requires it?
4. Press refresh in **Models → Providers**.

If replies arrive empty or garbled, the endpoint is probably not speaking standard `/v1/chat/completions` SSE. Try a different model or provider profile.

## Next

[Your first chat](first-chat.md)

## Related

- [Models app](../apps/models.md) — the full tour
- [Voice](../extend/voice.md) — speech-to-text and text-to-speech models
- [Troubleshooting](../reference/troubleshooting.md)
