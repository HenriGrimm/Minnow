# Models

This is where you set up what the agents run on: what your machine can handle, what you have downloaded, what is serving, which endpoints Minnow talks to, which model does which job, and what it all costs.

You come here to configure, then go back to Code and work. Open it from the app rail.

| Section | What it is |
|---------|------------|
| **Recommendations** | Hardware-aware suggestions from a probe of your machine |
| **Installed** | Model artifacts Minnow has downloaded |
| **Library** | Search Hugging Face, download, and serve locally |
| **Local Server** | What is loaded, live load/inference chips, runtime log |
| **Voice** | Speech-to-text and text-to-speech models |
| **Providers** | Endpoints and encrypted API keys |
| **Routing** | Which model handles which job |
| **Routers** | Shared capacity, sticky chat assignments, and model failover |
| **Sampler** | Temperature and sampling defaults |
| **Thinking** | Reasoning mode and budget |
| **Usage & cost** | Token totals and spend |

Providers, Routing, Sampler, Thinking, and Usage & cost also appear under **Models** in the Settings sidebar. Routers has its own page in Models.

## Local Server

This is the runtime dashboard: what is loaded, whether the process is healthy, and a live log. A loading card shows a modelled percent that actually moves (llama.cpp and mlx-lm do not print a weight-load percentage). Once the model is up, chips report prompt processing as a percent when the request came from Minnow, generated tokens as a count, and **N queued** when llama.cpp has more inference requests than free slots. mlx-lm has no server-side queue gauge, so that chip stays off.

Click a card to open the inspector on **Inference**, with **Loaded with** listing the flags that process was started with (llama.cpp launch flags, or for MLX the snapshot path, quant, mlx-lm version, port, and context). Loading a model from Code does not yank you here; Local Server only comes to the front if you were already in Models.

Idle `update_slots` heartbeats are dropped from the log so they cannot drown the lines that matter.

## Recommendations

Minnow probes your actual hardware — CPU, RAM, GPU, VRAM — and scores models by how well they will fit. Start here if you do not already know what your machine can handle; the alternative is downloading 40 GB to discover it swaps.

A **Catalog / Hugging Face** toggle sits at the left of the filter bar. Catalog is the curated list, ranked against your machine, with a fit level and a rough tokens-per-second estimate on every row. Hugging Face searches the Hub live and shows the most downloaded repos before you type anything.

The Hub cannot tell Minnow how a model will perform on your hardware, so those rows carry no fit level. What they do carry is the publisher, parameter count, download size, quantization, and whether the repo is gated. Gated repos need a Hugging Face token; the row offers to take you to Storage to add one rather than starting a download that can only fail.

The filter bar changes with the source, because target context, "Only what fits", use case, and quantization have no meaning for a Hub search.

## Library and Installed

**Library** searches Hugging Face and downloads weights into your Minnow home. **Serve** starts the bundled `llama-server` against a downloaded model and registers it as a provider automatically, so it shows up in the model picker with nothing else to configure.

**Loading GGUF on more than one GPU.** The inspector Load tab has a collapsed **GPUs** section. Check the cards that should run the model: the first you check is first in `--device` (so CUDA1 then CUDA0 means check CUDA1, then CUDA0). With two or more cards checked you can pick layer split (the default) or experimental tensor split, and drag per-card ratios. One GPU stays selected until you check another, so a second card stays free for the desktop. **Loaded with** lists Devices, Split, and Tensor split after a successful load. Extra llama-server args still override these fields.

**Installed** lists what is on disk so you can reclaim space later. Model files are large; they are deliberately kept out of the small-backup path described in [Where your data lives](../reference/configuration.md).

## MLX on Apple Silicon

On an Apple Silicon Mac, Minnow can also run **MLX** weights — Apple's Metal-native format. For the same quantization these are generally faster than GGUF on Metal, and the `mlx-community` and `lmstudio-community` accounts publish thousands of them.

MLX is Apple Silicon only. On Windows and Linux the option is not shown at all, and an MLX download is refused with an explanation rather than failing part way through.

**Getting set up.** The first MLX model you load asks to install the runtime. Minnow downloads a private Python environment and the `mlx-lm` packages — a few hundred megabytes, noticeably slower than the 20 MB llama.cpp install. The Python runtime is shared with Minnow's other managed servers, so it is only fetched once. You can also install it ahead of time from **Settings → Servers → MLX**.

**Downloading.** Search Hugging Face from Discover with the format set to MLX. An MLX model is a whole repository rather than a single file, so Minnow downloads the directory, skipping the original unquantized weights that many of these repos keep alongside the quantized ones.

**Loading.** MLX models appear in My Models with format `MLX` and a quant like `mlx-4bit`, and load the same way as GGUF — including a moving load percent while weights warm up. One difference is worth knowing: MLX runs as a single server that holds whichever model you asked for, so switching between two MLX models is a request rather than a process restart. The server keeps a model resident in memory after use; stop it from **Settings → Servers** when you want the RAM back. During a chat, prompt processing shows as a percent and generated tokens as a live count, same as GGUF.

Vision models are filtered out of MLX search. They need a different runtime that Minnow does not ship yet, and downloading 20 GB to hit a load error is not a useful way to find that out.

## Providers

A provider is an OpenAI-compatible endpoint. You can have as many as you like, enabled independently.

- **Local runtimes** — LM Studio on `http://localhost:1234` and Ollama on `http://localhost:11434/v1` are detected automatically when they are already running on their default ports.
- **Cloud APIs** — one-click presets for OpenCode Go/Zen, Anthropic, DeepSeek, GitHub Copilot, OpenRouter, OpenAI, Groq and Mistral, plus a custom option.
- **Managed** — anything you serve from the Library.

API keys are encrypted at rest with AES-256-GCM. Losing the key file in your Minnow home means re-entering them.

Refresh a provider after starting or stopping the underlying server; Minnow lists only what the provider reports.

Full walkthrough: [Connect a model](../get-started/connect-a-model.md).

## Routing

The section that most changes how Minnow feels.

Instead of one model doing everything, bind models to **roles**: main chat, utility tasks, the `/goal` evaluator, the UI Designer runtime, and each work agent and sub-agent type such as builder, planner, reviewer, and researcher.

Two bindings are worth setting deliberately:

- **Utility tasks.** One shared model handles chat titles, prompt and issue expansion, and git commit messages. Leave it unset to keep using the current composer, top-bar, or editor model for each task. A small fast model is often enough.
- **Goal evaluator.** This one judges whether your `/goal` condition is genuinely met. A weak evaluator rubber-stamps broken work, which is worse than no goal at all.

A common arrangement is a fast local model for routine turns and a capable cloud model bound to review, research and evaluation.

## Routers

Open **Models → Routers**, choose **New router**, and add models from **My Models** or your other configured providers. Local llama.cpp and MLX catalogs do not appear here — pick the weights from My Models, the same list as the chat picker. Each entry has an enabled toggle and a **Slots** limit for concurrent generations. The same provider/model pair cannot appear twice in one router. Reorder entries with the arrow buttons or **Alt+↑ / Alt+↓** while a row has keyboard focus, then **Save configuration**.

When a chat is assigned a My Models entry that is not loaded, Minnow loads it before generating. If another local model is still producing a response, the router waits for that work to finish, then unloads it if residency requires and loads the assigned weights. Idle TTL (twenty minutes) still applies. Cloud and LM Studio entries are unchanged.

**Priority** prefers the first eligible model with free capacity. **Balance by rank** assigns new chats using rank weights: a three-entry router uses weights 3, 2, and 1. Once assigned, a chat keeps that model. If its model is busy, the chat waits in a FIFO queue even when another entry has capacity. If all entries are busy, new chats queue too. Streaming and non-streaming generations each occupy one slot.

Routers appear in the normal model picker with a **Router** label. **Default for new chats** sets the workspace's default router; existing chat bindings stay unchanged. A chat's picker shows the router and its current provider/model assignment after a request starts.

The live view shows active and queued chats, their target models, and slot usage. Inspect a model card for average generation latency, error rate, reported tokens, and estimated cost when provider pricing and token counts are available. The chat's override selector pins an entry until you choose **Router assignment** to clear it. An override can fail over if its model fails; the replacement becomes sticky while the override remains marked until cleared.

Provider errors and unavailable models trigger failover. A response interrupted partway through restarts on another eligible entry with a visible warning; failed text, reasoning, and incomplete tool calls are discarded. Each request attempts a provider/model pair at most once. **Stop** cancels the request without failover. If no eligible entries remain, Minnow asks you to check the router's entries and provider configuration.

Router configurations, defaults, and chat assignments are saved per workspace. Activity and telemetry last for the current server session. On narrow screens the activity and model views stack; reduced-motion settings replace moving connections with static indicators.

## Sampler

Temperature, top-p, top-k, min-p, repeat penalty, presence penalty, max tokens.

The defaults are tuned for the failure mode local models actually have: repetition loops. Presence penalty does that job here; repeat penalty and min-p are deliberately left off because they degrade output on the models Minnow targets. Change these only when you are chasing a specific problem, and change one at a time.

## Thinking

Reasoning mode and token budget for models that expose reasoning. Minnow displays reasoning separately from the answer and times it — the "Thinking…" clock covers reasoning only, stopping when tool calls begin, so the number means something.

## Usage & cost

Token totals for the active chat and for the workspace session. Enter per-million pricing for your models and it becomes actual spend rather than an abstract count.

## Voice

Download local **Whisper** for speech-to-text and **Qwen3-TTS** for text-to-speech, or point voice at a provider instead. Local voice provisions a Python worker on first use.

See [Voice](../extend/voice.md).

## Choosing the model for a turn

| Control | Scope |
|---------|-------|
| **Menubar model chip** | Global default — what new chats start with |
| **Composer picker, Ctrl+M / Cmd+M** | This chat only |

Local runtimes expose **Load** and **Unload** in the composer picker, acting on the model that chat is bound to. The tray menu can unload local models without opening the window — useful when you want your VRAM back. Live load and inference numbers live on **Local Server**.

## When the picker is empty

1. Is the provider process running, with a model loaded?
2. Is the base URL right, including `/v1` where required?
3. Press refresh in **Providers**.

`[providers] fetch failed` at startup is normal when a local runtime is not up yet.

## Related

- [Connect a model](../get-started/connect-a-model.md)
- [Voice](../extend/voice.md)
- [Settings app](settings.md)
- [Troubleshooting](../reference/troubleshooting.md)
