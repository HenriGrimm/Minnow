# Models

This is where you set up what the agents run on: what your machine can handle, what you have downloaded, what is serving, which endpoints Minnow talks to, which model does which job, and what it all costs.

You come here to configure, then go back to Code and work. Open it from the app rail.

| Section | What it is |
|---------|------------|
| **Discover** | Curated recommendations, Hugging Face search, file selection, and downloads |
| **My models** | Downloaded models and local loading |
| **Storage** | Model folders and Hugging Face credentials |
| **Local Server** | What is loaded, live load/inference chips, runtime log |
| **Voice** | Speech-to-text and text-to-speech models |
| **Providers** | Endpoints and encrypted API keys |
| **CLIs** | Claude Code, Codex, and Cursor subscriptions through installed CLIs |
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

## Discover

**Recommended** is a short, hand-curated list for coding, everyday work, and reasoning. Each pick explains its purpose and shows a default Q4_K_M file size. Models within your estimated memory budget appear first. Filter by purpose or select **Within memory budget** to narrow the list.

**Context tokens** controls the memory estimate, starting at 16,384 tokens. Larger contexts need more memory. A model that needs a shorter context is labeled **Context too long**; Minnow does not silently shorten your selection to claim a fit. Estimates include runtime overhead and headroom. They distinguish GPU memory, unified memory, and slower CPU execution in RAM. Actual usage depends on runtime settings and other applications. Unknown metadata produces **Fit unknown**, not a promise that the model fits.

**Hugging Face** searches repositories by model name or `owner/repository`. Sort by downloads, likes, or recent updates, then use **Load more models** for the next page. GGUF is available on every platform; MLX is offered on Apple Silicon. Hugging Face results are not editorial recommendations.

Select **Inspect files** or **Inspect** to open the file inspector. Choose the exact GGUF quantization before downloading. Each choice shows its filename and download size; the memory estimate updates for that file. Split GGUF files appear as one choice with a total size and shard count. Missing shards disable that choice. Projector-only files are omitted. The model-card link opens the repository on Hugging Face. Access errors offer a route to Hugging Face settings; gated repositories may also require accepting the license on Hugging Face.

The **Downloads** shelf keeps progress, speed, and estimated time visible. **Pause** retains downloaded bytes; **Resume** continues the same job. **Cancel & discard** removes that transfer's artifacts. Failed transfers stay visible with an error and **Retry download**. Network failures retain partial files, while checksum failures discard corrupt bytes so retry can start cleanly. Completed jobs offer **Open in My Models**. Running jobs resume after restarting Minnow; deliberately paused jobs stay paused.

## My models and Storage

Downloads from **Discover** appear in **My models**. Select a model and use the inspector to load it with the local runtime. Minnow registers the runtime as a provider so the model becomes available in Code.

**Parallel slots and KV cache.** In the Load tab, **Unified KV cache** makes the selected context one shared token pool. For example, 98,304 tokens with three slots allocates 98,304 tokens of KV capacity; concurrent requests share that capacity. With unified KV off, the context is per slot and the same selection allocates 294,912 tokens. The memory estimate updates when you change this setting. Existing saved context totals remain intact until you adjust the slider.

**Loading GGUF on more than one GPU.** The inspector Load tab has a collapsed **GPUs** section. Check the cards that should run the model: the first you check is first in `--device` (so CUDA1 then CUDA0 means check CUDA1, then CUDA0). With two or more cards checked you can pick layer split (the default) or experimental tensor split, and drag per-card ratios. One GPU stays selected until you check another, so a second card stays free for the desktop. **Loaded with** lists Devices, Split, and Tensor split after a successful load. Extra llama-server args still override these fields.

**Storage** manages additional model folders and Hugging Face credentials. Model files are large; they are kept out of the small-backup path described in [Where your data lives](../reference/configuration.md).

## MLX on Apple Silicon

On an Apple Silicon Mac, Minnow can also run **MLX** weights — Apple's Metal-native format. For the same quantization these are generally faster than GGUF on Metal, and the `mlx-community` and `lmstudio-community` accounts publish thousands of them.

MLX is Apple Silicon only. On Windows and Linux the option is not shown at all, and an MLX download is refused with an explanation rather than failing part way through.

**Getting set up.** The first MLX model you load asks to install the runtime. Minnow downloads a private Python environment and the `mlx-lm` packages — a few hundred megabytes, noticeably slower than the 20 MB llama.cpp install. The Python runtime is shared with Minnow's other managed servers, so it is only fetched once. You can also install it ahead of time from **Settings → Servers → MLX**.

**Downloading.** Search Hugging Face from Discover with the format set to MLX. An MLX model is a whole repository rather than a single file, so Minnow downloads the directory, skipping the original unquantized weights that many of these repos keep alongside the quantized ones.

**Loading.** MLX models appear in My Models with format `MLX` and a quant like `mlx-4bit`, and load the same way as GGUF — including a moving load percent while weights warm up. One difference is worth knowing: MLX runs as a single server that holds whichever model you asked for, so switching between two MLX models is a request rather than a process restart. The server keeps a model resident in memory after use; stop it from **Settings → Servers** when you want the RAM back. During a chat, prompt processing shows as a percent and generated tokens as a live count, same as GGUF.

Vision models are filtered out of MLX search. They need a different runtime that Minnow does not ship yet, and downloading 20 GB to hit a load error is not a useful way to find that out.

## Providers

A provider connects Minnow to a model service. You can have as many as you like, enabled independently.

- **Local runtimes** — LM Studio on `http://localhost:1234` and Ollama on `http://localhost:11434` are detected automatically when they are already running on their default ports.
- **Cloud APIs** — one-click presets for OpenCode Go/Zen, Anthropic, DeepSeek, GitHub Copilot, OpenRouter, OpenAI, Groq and Mistral, plus a custom option.
- **Managed** — anything you serve from the Library.

API keys are encrypted at rest with AES-256-GCM. Losing the key file in your Minnow home means re-entering them.

Select a provider row to open its connection card. Changes save automatically when a field loses focus or you press Enter. The status below the fields confirms when they are saved. **Advanced settings** contains API paths, authentication headers, gateway routing, pricing, and capability checks. CLI connections have a **Manage CLI** link.

Choose **Add provider** for a local or cloud preset, or **Custom endpoint** for another server. Provider IDs are filled in automatically and can be edited under Advanced settings.

**Test connection** checks the saved endpoint and reports the available model count or a connection error. Wait for edits to finish saving before testing. This check does not generate a model response.

Full walkthrough: [Connect a model](../get-started/connect-a-model.md).

## CLIs

Use an installed **Claude Code**, **Codex**, or **Cursor CLI** as a model provider. Open **Models → CLIs**, scan for installations, and expand a CLI row to enable it. Its models appear in the normal model picker and can be assigned to chats and work agents.

If a CLI is missing, choose **Install**. Minnow opens Terminal and runs the vendor installer for that shell — including Cursor's PowerShell installer on Windows. When the installer finishes, return and choose **Scan again**. **Sign in** opens a dedicated Minnow terminal for the CLI's login flow. After signing in, choose **Verify**. Scanning and verification do not generate a model response or consume an inference request. Some credential stores cannot report login status; **Sign-in unverified** means Minnow could not confirm it. Credentials stay with the CLI. Codex sign-in uses its native `auth.json` file store so isolated requests can reuse the login; a keyring-only login needs this sign-in step once. Your saved CLI configuration is not changed.

Each expanded row shows connection controls, concurrent runs, and the context window. Claude Code also offers a budget per turn. **Advanced settings** contains the executable path override and **Allow helper tasks**. Changes save automatically as you edit; the status below the fields confirms when they are saved. If a save fails, your input stays in place and **Retry** sends it again.

Concurrency defaults to one; further requests wait in order, and Stop also cancels a queued request. Background use is off by default so title generation, editor completions, and similar utility jobs do not silently use your subscription. Assign those jobs another provider or explicitly enable helper tasks. Claude Code's optional dollar budget covers one user turn, including its tool steps. Each new user message starts a fresh process and resumes the conversation with a fresh budget; previously reported spend is excluded from that cap.

**Context window (tokens)** defaults to automatic model discovery. Enter 1,000–1,000,000 tokens to set an explicit budget, or clear the field to restore automatic. Codex receives this window in its native configuration; select a value your model supports. Claude requests extended context above 200,000 for Sonnet and Opus when your account supports it; Haiku remains capped at 200,000. A value at or below 200,000 holds Claude to its smaller native window. Cursor's setting only lowers Minnow's budget below the model's advertised capacity; it cannot enlarge Cursor's native window. Changes apply when the next generation starts.

Conversations continue automatically while each generation request ends when the CLI finishes its response. Claude Code keeps streaming input open; Codex uses a managed app-server connection and requires CLI 0.153.4 or newer. Ordinary follow-ups send only new input. Minnow retains up to eight idle processes per provider for five minutes. Clean, matching saved conversations resume after eviction or a Minnow restart. Cursor uses its ACP session protocol when its installed version passes the session-loading handshake and Minnow's tool-isolation requirements; otherwise Minnow selects isolated replay before sending a prompt and shows the reason in the CLI view.

Edits, regeneration, context trimming, instruction or tool changes, workspace changes, account changes, and interrupted or modified native histories reconstruct the conversation from Minnow's recorded history. Stable instructions stay separate from current-turn context; changing an opaque custom system prompt also reconstructs the conversation. Minnow returns real tool results to the same native turn when available and reconstructs with recorded results after an interruption, without executing those tools again. Pending tool requests use their own timeout. The CLI can request up to eight independent Minnow tools in one batch; Minnow applies the usual mode restrictions, approvals, tool cards, user questions, and board reporting. **Stop** cancels the generation and closes its process. Closing a workspace releases its processes while retaining valid saved conversations; deleting a chat removes its saved binding. Unused CLI session caches expire after 30 days and are excluded from backups.

When a chat uses a CLI provider, the **CLI** button at the upper right of the conversation shows the current process output as it runs. Select **Chat** to return to the conversation. This view appends native JSON output as it arrives and recovers a recent snapshot after reconnecting. Claude and Cursor also show recent stderr. The view is read-only, and messages are still sent through the chat composer. The recent output remains available until Minnow restarts or the capture is replaced by a new process.

The CLI view distinguishes **Ready for next message**, **Waiting for Minnow tool results**, **Resumed saved conversation**, and **Conversation rebuilt**, with the rebuild or fallback reason. Usage covers the latest generation and separates uncached input, cache reads, cache writes, and output where the CLI reports them. Missing counts or cost show as unavailable. When Claude reports one cost for several requests across tool steps, it is labeled **Native turn total**; an unavailable per-generation cost is not replaced with that whole-turn amount. Token totals and reported dollar cost are not subscription quota measurements. Conversation persistence enables cache reuse but does not guarantee reduced subscription usage or preserve a provider cache indefinitely.

Claude Code offers moving aliases and pinned version choices supported by the detected CLI version. Alias resolution can vary by provider; a pinned model ID keeps the version fixed. Claude Code supports image attachments and reasoning effort. Codex supports reasoning effort and lists models through the installed CLI, independently of the Codex desktop app. Model discovery does not generate a reply; choices are cached for up to five minutes. If a saved model is no longer supported, refresh the model list and choose a supported model, or update the CLI using Install; Cursor uses its CLI's model defaults, including the models your account lists. Unsupported sampling options are not forwarded. CLI conversations travel over standard input with an 8 MB transcript bound. Codex submits only new input while its accepted conversation remains available. CLI access, available models, and account limits follow the installed CLI and your account.

Minnow disables Claude Code's automatic session-title inference. Chat titles use Minnow's configured title provider and background-use controls.

## Routing

The section that most changes how Minnow feels.

Instead of one model doing everything, bind models to **roles**: main chat, utility tasks, the `/goal` evaluator, the UI Designer runtime, and each work agent and sub-agent type such as builder, planner, reviewer, and researcher.

Two bindings are worth setting deliberately:

- **Utility tasks.** One shared model handles chat titles, prompt and issue expansion, and git commit messages. Leave it unset to keep using the current composer, top-bar, or editor model for each task. A small fast model is often enough.
- **Goal evaluator.** This one judges whether your `/goal` condition is genuinely met. A weak evaluator rubber-stamps broken work, which is worse than no goal at all.

A common arrangement is a fast local model for routine turns and a capable cloud model bound to review, research and evaluation.

## Routers

Open **Models → Routers**, choose **New router**, and add models from **My Models** or your other configured providers. Local llama.cpp and MLX catalogs do not appear here — pick the weights from My Models, the same list as the chat picker. Each entry has an enabled toggle and a **Slots** limit for concurrent generations. The same provider/model pair cannot appear twice in one router. Reorder entries with the arrow buttons or **Alt+↑ / Alt+↓** while a row has keyboard focus; changes save automatically.

When a chat is assigned a My Models entry that is not loaded, Minnow loads it before generating. If another local model is still producing a response, the router waits for that work to finish, then unloads it if residency requires and loads the assigned weights. Idle TTL (twenty minutes) still applies. Cloud and LM Studio entries are unchanged.

**Priority** prefers the first eligible model with free capacity. **Balance by rank** assigns new chats using rank weights: a three-entry router uses weights 3, 2, and 1. Once assigned, a chat keeps that model. If its model is busy, the chat waits in a FIFO queue even when another entry has capacity. If all entries are busy, new chats queue too. Streaming and non-streaming generations each occupy one slot.

Routers appear in the normal model picker with a **Router** label. **Default for new chats** sets the workspace's default router; existing chat bindings stay unchanged. A chat's picker shows the router and its current provider/model assignment after a request starts.

The live view shows active and queued chats, their target models, and slot usage. Inspect a model card for average generation latency, error rate, reported tokens, and estimated cost when provider pricing and token counts are available. The chat's override selector pins an entry until you choose **Router assignment** to clear it. An override can fail over if its model fails; the replacement becomes sticky while the override remains marked until cleared.

Provider errors and unavailable models trigger failover. A response interrupted partway through restarts on another eligible entry with a visible warning; failed text, reasoning, and incomplete tool calls are discarded. Each request attempts a provider/model pair at most once. **Stop** cancels the request without failover. If no eligible entries remain, Minnow asks you to check the router's entries and provider configuration.

Router configurations, defaults, and chat assignments are saved per workspace. Activity and telemetry last for the current server session. On narrow screens the activity and model views stack; reduced-motion settings replace moving connections with static indicators.

## Sampler

Temperature, top-p, top-k, min-p, repeat penalty, presence penalty, max tokens.

For a downloaded model, open its inspector and choose **Inference → Recommended preset**. Select a preset and click **Apply preset** to fill and save the recommended sampler values for that model. Every field stays editable, and your later changes are saved. Selecting a model or choosing a preset in the dropdown leaves your current values in place until you apply it.

Presets cover Qwen3, Qwen3.5, Qwen3.6, Qwen3.8 (including Flash Next), Qwen3 Coder Next, Gemma 4 instruction models, and DeepSeek R1 (including distills). The **Model guidance** link opens the official recommendation. Thinking and non-thinking presets describe the sampling to use with that mode; set the thinking mode separately in the composer or **Thinking** settings. Applying a preset preserves your output limit and any sampler fields the recommendation does not specify. Empty fields inherit global defaults. Models without a known recommendation keep the same editable fields.

For example, **Thinking / precise coding** for Qwen3.6 sets temperature **0.6**, top-p **0.95**, top-k **20**, min-p **0**, presence penalty **0**, and repeat penalty **1.0**. Explicit zero and neutral values override inherited sampling values on supported runtimes. Providers may support only some sampler parameters.

## Thinking

Reasoning mode and token budget for models that expose reasoning. Minnow displays reasoning separately from the answer and times it — the "Thinking…" clock covers reasoning only, stopping when tool calls begin, so the number means something.

For models that expose named reasoning levels, open the model picker and set **Reasoning default** below the model list. The choice is saved for that provider and model, then applied when you select it in a chat. Choose **Model default** to use the level advertised by the provider again. The composer control can still override the level for the current chat.

## Usage & cost

Token totals for the active chat and for the workspace session. Enter per-million pricing for your models and it becomes actual spend rather than an abstract count.

## Voice

Built-in dictation automatically downloads a compact speech model on first use. System voices provide read-aloud without a model download. Optional larger **Whisper** and **Qwen3-TTS** models use the advanced local Python runtime; external voice providers are also supported.

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
3. Open the provider card and choose **Test connection**.

`[providers] fetch failed` at startup is normal when a local runtime is not up yet.

## Related

- [Connect a model](../get-started/connect-a-model.md)
- [Voice](../extend/voice.md)
- [Settings app](settings.md)
- [Troubleshooting](../reference/troubleshooting.md)
