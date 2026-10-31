# Models

This is where you set up what the agents run on: what your machine can handle, what you have downloaded, what is serving, which endpoints Minnow talks to, which model does which job, and what it all costs.

You come here to configure, then go back to Code and work. Open **Models** in the top bar for quick routing controls, then choose **Manage models…** for the full screen.

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

Select a session to follow its runtime log and open its **Overview**. Expand **Runtime snapshot** to see the values that session started with: llama.cpp launch flags, MLX snapshot details, or readable MTPLX settings. The **Connection** area shows the selected ready model's base URL and model identifier, with copy controls and supported endpoints. **Stop all** stops the running models. Loading a model from Code does not yank you here; Local Server only comes to the front if you were already in Models.

Idle `update_slots` heartbeats are dropped from the log so they cannot drown the lines that matter.

## Discover

**Recommended** is a short, hand-curated list for coding, everyday work, and reasoning. Each pick explains its purpose and shows a default Q4_K_M file size. Models within your estimated memory budget appear first. Filter by purpose or select **Within memory budget** to narrow the list.

**Context tokens** controls the memory estimate, starting at 16,384 tokens. Larger contexts need more memory. A model that needs a shorter context is labeled **Context too long**; Minnow does not silently shorten your selection to claim a fit. Estimates include runtime overhead and headroom. They distinguish GPU memory, unified memory, and slower CPU execution in RAM. Actual usage depends on runtime settings and other applications. Unknown metadata produces **Fit unknown**, not a promise that the model fits.

**Hugging Face** searches repositories by model name or `owner/repository`. Sort by downloads, likes, or recent updates, then use **Load more models** for the next page. GGUF is available on every platform; MLX is offered on Apple Silicon. Hugging Face results are not editorial recommendations.

Select **Inspect files** or **Inspect** to open the file inspector. Choose the exact GGUF quantization before downloading. Each choice shows its filename and download size; the memory estimate updates for that file. Split GGUF files appear as one choice with a total size and shard count. Missing shards disable that choice. Projector-only files are omitted. The model-card link opens the repository on Hugging Face. Access errors offer a route to Hugging Face settings; gated repositories may also require accepting the license on Hugging Face.

The **Downloads** shelf keeps progress, speed, and estimated time visible. **Pause** retains downloaded bytes; **Resume** continues the same job. **Cancel & discard** removes that transfer's artifacts. Failed transfers stay visible with an error and **Retry download**. Network failures retain partial files, while checksum failures discard corrupt bytes so retry can start cleanly. Completed jobs offer **Open in My Models**. Running jobs resume after restarting Minnow; deliberately paused jobs stay paused.

## My models and Storage

Downloads from **Discover** appear in **My models**. Search or filter by maker, publisher, and format, or use **Loaded** and **Needs attention** to narrow the library. Quantizations of the same model share a row. **Load** uses that model's saved settings; the launch-settings button opens a large popover for adjusting them. Minnow registers the runtime as a provider so the model becomes available in Code.

Select a model to open its details panel. **Overview** shows runtime status, model size, trained context, capabilities, and connection copy controls when running. Expand **Model & files** for the repository, architecture, and local path, or **Runtime snapshot** for the current session's launch values. **Inference** provides per-model sampling controls with explanations and recommended presets. The panel's **Load settings** button opens the popover and returns to the same tab when you close it. The close button collapses the details panel.

**Basic settings** explains the everyday controls. For llama.cpp, choose context length, GPU layers, and KV cache precision, with a memory estimate above them. GPU **Auto** chooses a split for your hardware. For MTPLX, Basic exposes profile, context window, conversation-memory compression, and supported reasoning controls, with an estimate of unified memory. Available options and limits come from the model's MTPLX descriptor.

**Advanced settings** contains the detailed runtime controls: GPU selection, parallel slots, memory, speculative decoding, and extra arguments for llama.cpp; model, MTP heads, sampling, reasoning, performance, memory, persistent cache (SSD), thermal, and advanced controls for MTPLX. Switching between Basic and Advanced retains your edits. Changes save automatically and apply on the next load. **Use defaults** restores the selected engine's automatic or inherited settings. Close the popover with its close button, Escape, or a click outside it.

To remove a model from disk, choose the trash button on its row and confirm **Delete model**. If the row has a quantization picker, deletion applies to the selected quantization, including every shard of a split GGUF; other quantizations and shared image projectors are kept. MLX deletion removes the model folder and its contents, including all revisions of a Hugging Face cache repo. The confirmation shows the model and its current path. Eject a loaded model first, and cancel any unfinished download for its repo before deleting. Files in custom model folders are deleted from their original location too.

**Parallel slots and KV cache.** In the load popover, **Unified KV cache** makes the selected context one shared token pool. For example, 98,304 tokens with three slots allocates 98,304 tokens of KV capacity; concurrent requests share that capacity. With unified KV off, the context is per slot and the same selection allocates 294,912 tokens. The memory estimate updates when you change this setting. Existing saved context totals remain intact until you adjust the slider.

**Loading GGUF on more than one GPU.** The load popover's **Advanced settings** has a collapsed **GPUs** section. Check the cards that should run the model: the first you check is first in `--device` (so CUDA1 then CUDA0 means check CUDA1, then CUDA0). With two or more cards checked you can pick layer split (the default) or experimental tensor split, and drag per-card ratios. One GPU stays selected until you check another, so a second card stays free for the desktop. **Loaded with** lists Devices, Split, and Tensor split after a successful load. Extra llama-server args still override these fields.

**Storage** manages additional model folders and Hugging Face credentials. Model files are large; they are kept out of the small-backup path described in [Where your data lives](../reference/configuration.md).

**Runtime log.** Local Server shows the selected runtime's complete recorded output and follows new messages. Minnow starts llama.cpp with verbose logging, including generated token IDs and text. Reload an already-running GGUF model to enable verbose output; an explicit verbosity setting in extra arguments takes precedence. Copy log copies the full received output, and Clear view clears the pane until more output arrives. Other engines show the messages their runtime emits.

## MLX on Apple Silicon

On an Apple Silicon Mac, Minnow can also run **MLX** weights — Apple's Metal-native format. For the same quantization these are generally faster than GGUF on Metal, and the `mlx-community` and `lmstudio-community` accounts publish thousands of them.

MLX is Apple Silicon only. On Windows and Linux the option is not shown at all, and an MLX download is refused with an explanation rather than failing part way through.

**Getting set up.** The first MLX model you load asks to install the runtime. Minnow downloads a private Python environment and the `mlx-lm` packages — a few hundred megabytes, noticeably slower than the 20 MB llama.cpp install. The Python runtime is shared with Minnow's other managed servers, so it is only fetched once. You can also install it ahead of time from **Settings → Servers → MLX**.

**Downloading.** Search Hugging Face from Discover with the format set to MLX. An MLX model is a whole repository rather than a single file, so Minnow downloads the directory, skipping the original unquantized weights that many of these repos keep alongside the quantized ones.

**Loading.** MLX models appear in My Models with format `MLX` and a quant like `mlx-4bit`, and load the same way as GGUF — including a moving load percent while weights warm up. One difference is worth knowing: MLX runs as a single server that holds whichever model you asked for, so switching between two MLX models is a request rather than a process restart. The server keeps a model resident in memory after use; stop it from **Settings → Servers** when you want the RAM back. During a chat, prompt processing shows as a percent and generated tokens as a live count, same as GGUF.

Vision models are filtered out of MLX search. They need a different runtime that Minnow does not ship yet, and downloading 20 GB to hit a load error is not a useful way to find that out.

## MTPLX on Apple Silicon

MTPLX runs MLX weights with multi-token prediction on Apple Silicon and macOS 14 or newer. Install MTPLX separately (`pip install --upgrade mtplx`); Minnow detects the installed executable and lists its model cache in **My Models**. **Settings → Servers → MTPLX → Diagnostics** shows the runtime's troubleshooting checks.

Select a model and open **Load → Engine**. Validated MTPLX rows offer **Powered by MTPLX** and **MLX (no MTP acceleration)**. Missing files appear as a reason the model cannot load. In Discover, MLX snapshot downloads can target the **MTPLX cache**; the runtime validates them after downloading.

MTPLX controls use the same names as the MTPLX app's settings, so values carry over by name. **Performance → Mode** offers **Fastest response**, **Handle multiple at once**, and **Long agent tasks**; **Concurrency cap** sets how many completions run in parallel, and picking a Mode resets it, **Decode batch max**, and **Admission window** to that Mode's preset. The model supplies control bounds where available. Saved values outside those bounds are adjusted with a warning. Memory figures before loading are conservative estimates; the runtime determines its actual memory requirements.

If a matching MTPLX daemon already runs on the configured port or default port 8000, Minnow connects to it and marks it **External daemon**. Its existing settings remain in effect. **Eject** disconnects Minnow without terminating that daemon. Otherwise Minnow starts a process, manages its idle timeout, and stops it on eject or app shutdown. Requests sent directly to its endpoint also renew the idle window. A daemon that crashes after a healthy run receives one automatic restart with the same port and settings. Local Server shows decode/prefill speed, time to first token, cached tokens, MTP depth and active requests.

Powered by [MTPLX](https://github.com/youssofal/MTPLX).

## Providers

A provider connects Minnow to a model service. You can have as many as you like, enabled independently.

- **Local runtimes** — LM Studio on `http://localhost:1234` and Ollama on `http://localhost:11434` are detected automatically when they are already running on their default ports.
- **Cloud APIs** — one-click presets for OpenCode Go/Zen, Anthropic, DeepSeek, GitHub Copilot, OpenRouter, OpenAI, Groq and Mistral, plus a custom option.
- **Managed** — anything you serve from the Library.

API keys are encrypted at rest with AES-256-GCM. Losing the key file in your Minnow home means re-entering them.

Supported connections show **Account usage** in their connection card and beside the active chat's model control. DeepSeek reports its available balance, including granted and topped-up credit, in the account's currency. OpenCode Go reports rolling, weekly and monthly allowance used and remaining, with reset times where supplied. These are account-wide figures, not estimates from Minnow's chat token counts. Unknown measurements are omitted.

Account checks use the saved encrypted provider credentials and read-only account endpoints, never a paid generation request. Results are cached for one minute in memory; the usage view shows when they were checked. A provider that does not expose account data shows no figures.

Select a provider row to open its connection card. Changes save automatically when a field loses focus or you press Enter. The status below the fields confirms when they are saved. **Advanced settings** contains API paths, authentication headers, gateway routing, pricing, and capability checks. CLI connections have a **Manage CLI** link.

Choose **Add provider** for a local or cloud preset, or **Custom endpoint** for another server. Provider IDs are filled in automatically and can be edited under Advanced settings.

**Test connection** checks the saved endpoint and reports the available model count or a connection error. Wait for edits to finish saving before testing. This check does not generate a model response.

Full walkthrough: [Connect a model](../get-started/connect-a-model.md).

## CLIs

Use an installed **Claude Code**, **Codex**, or **Cursor CLI** as a model provider. Open **Models → CLIs**, scan for installations, and expand a CLI row to enable it. Its models appear in the normal model picker and can be assigned to chats and work agents.

If a CLI is missing, choose **Install**. Minnow opens Terminal and runs the vendor installer for that shell — including Cursor's PowerShell installer on Windows. When the installer finishes, return and choose **Scan again**. **Update** runs the CLI's own updater (`claude update`, `codex update`, or `cursor-agent update`) in Terminal, so you get each vendor's latest release as soon as it ships. Minnow first closes idle CLI processes it started so the update can replace their files; chats that are running keep going, and closed conversations resume on the next message. When the update finishes, choose **Scan again** to pick up the new version and any models it adds. **Sign in** shows connection progress here while you approve access in your browser. Use **Open sign-in page** if the browser does not open. Minnow verifies the login automatically; you can cancel or retry without leaving Models. If Claude shows a code after browser approval, expand **Browser gave you a sign-in code?** and paste it here. **Verify** checks a login you completed elsewhere. Scanning and verification do not generate a model response or consume an inference request. Some credential stores cannot report login status; **Sign-in unverified** means Minnow could not confirm it. Credentials stay with the CLI. Codex sign-in uses its native `auth.json` file store so isolated requests can reuse the login; a keyring-only login needs this sign-in step once. Your saved CLI configuration is not changed.

Each expanded row shows connection controls, concurrent runs, and the context window. Claude Code retains a dollar-budget field for the legacy headless connection; leave it empty for interactive chat. **Advanced settings** contains the executable path override and **Allow helper tasks**. Changes save automatically as you edit; the status below the fields confirms when they are saved. If a save fails, your input stays in place and **Retry** sends it again.

Concurrency defaults to one; further requests wait in order, and Stop also cancels a queued request. Background use is off by default so title generation, editor completions, and similar utility jobs do not silently use your subscription. Assign those jobs another provider or explicitly enable helper tasks. Claude Code's interactive connection does not support the CLI dollar-budget flag. If a budget is configured, Minnow asks you to clear it before starting interactive chat; it never silently ignores the cap.

**Context window (tokens)** defaults to automatic model discovery. Enter 1,000–1,000,000 tokens to set an explicit budget, or clear the field to restore automatic. Codex receives this window in its native configuration; select a value your model supports. Claude requests extended context above 200,000 for Sonnet and Opus when your account supports it; Haiku remains capped at 200,000. A value at or below 200,000 holds Claude to its smaller native window. Cursor's setting only lowers Minnow's budget below the model's advertised capacity; it cannot enlarge Cursor's native window. Changes apply when the next generation starts.

Conversations continue automatically while each generation request ends when the CLI finishes its response. Claude Code runs an interactive session behind normal chat and requires CLI 2.1.289 or newer; Codex uses a managed app-server connection and requires CLI 0.153.4 or newer. Ordinary follow-ups send only new input. Minnow retains up to eight idle processes per provider for five minutes. Clean, matching saved conversations resume after eviction or a Minnow restart. Cursor uses its ACP session protocol when its installed version passes the session-loading handshake and Minnow's tool-isolation requirements; otherwise Minnow selects isolated replay before sending a prompt.

Claude sends text and images through its private connection, with background prompt suggestions disabled. Minnow continues to handle tool execution and approvals. Token counts come from completed native responses; missing dollar-cost or quota measurements remain unavailable.

The first interactive connection keeps Claude's selected display theme and continues its informational security notice. If Claude needs sign-in, use **Sign in** here. If it needs additional first-run setup, run `claude` once in Minnow Terminal, finish those prompts, then retry your chat.

Claude also saves checkpoints at tool handoffs. After an interruption, a matching conversation resumes from the checkpoint when all pending tool results are recorded, sending those results without replaying the earlier conversation. If the saved history or configuration no longer matches, Minnow rebuilds from its recorded history. CLI providers receive their permitted tools together to keep the conversation stable as work progresses.

Edits, regeneration, context trimming, instruction or tool changes, workspace changes, account changes, and interrupted or modified native histories reconstruct the conversation from Minnow's recorded history. Stable instructions stay separate from current-turn context; changing an opaque custom system prompt also reconstructs the conversation. Minnow returns real tool results to the same native turn when available and reconstructs with recorded results after an interruption, without executing those tools again. Pending tool requests use their own timeout. The CLI can request up to eight independent Minnow tools in one batch; Minnow applies the usual mode restrictions, approvals, tool cards, user questions, and board reporting. **Stop** cancels the generation and closes its process. Closing a workspace releases its processes while retaining valid saved conversations; deleting a chat removes its saved binding. Unused CLI session caches expire after 30 days and are excluded from backups.

Conversation persistence enables cache reuse but does not guarantee reduced subscription usage or preserve a provider cache indefinitely.

Claude Code offers moving aliases and pinned version choices supported by the detected CLI version. Alias resolution can vary by provider; a pinned model ID keeps the version fixed. Claude Code supports image attachments and reasoning effort. Codex supports reasoning effort, image attachments, and tool screenshots when the selected model accepts images. It lists models and their image support through the installed CLI, independently of the Codex desktop app. Model discovery does not generate a reply; choices are cached for up to five minutes. If a saved model is no longer supported, refresh the model list and choose a supported model, or update the CLI using Install; Cursor uses its CLI's model defaults, including the models your account lists. Unsupported sampling options are not forwarded. CLI conversations travel over standard input with an 8 MB transcript bound. Codex submits only new input while its accepted conversation remains available. CLI access, available models, and account limits follow the installed CLI and your account.

Minnow disables Claude Code's automatic session-title inference. Chat titles use Minnow's configured title provider and background-use controls.

### Account usage

Codex, Claude and Cursor connections show subscription allowance in **Models → CLIs**.
Open a CLI row for each quota window, its remaining percentage, reset time and
last refresh. Cursor reports its monthly included usage as Total, Auto and API
meters that reset at the end of your billing cycle. When a Code chat uses one of these CLIs, the **Usage** button beside
the model opens the same account details. After loading, the button shows the
remaining percentage for the most-used window.

Usage covers your account, including activity outside Minnow. Checking it does
not generate a model response. Visible usage indicators refresh about once a
minute; **Refresh** checks again subject to the provider's retry interval. If a
refresh fails, Minnow labels recent measurements as **last-known usage**. An
asterisk beside the composer's percentage also marks last-known data. Missing
limits show as unavailable rather than zero usage.

Codex requires a ChatGPT login; Claude requires a current subscription OAuth
login. API keys and other API configurations do not provide subscription quota.
Login credentials stay on the tool server. Claude uses the usage endpoint used
by its CLI; changes to that endpoint can temporarily make usage unavailable.
If your login expires, verify or sign in through the CLI and refresh usage.

## Routing

Open **Models** in the top bar to choose dedicated models for **Sub-agents**, **Utility tasks**, **Editor assistance**, and **Goal evaluation**. The same settings appear on **Models → Routing** and during optional routing setup in onboarding. Changes save automatically; failed saves offer a retry.

Sub-agents start on **Follow parent chat**. A fixed model or pool applies to new sub-agent runs. **Advanced sub-agent routing** keeps per-type choices; a type override takes precedence over the general sub-agent setting. Existing and queued runs keep the binding captured when they started. Run details identify the selected model and routing source.

Utility tasks cover chat titles, prompt and issue expansion, and git commit messages. Leave the override empty to follow the originating task. Editor assistance and goal evaluation can follow their chat or use a dedicated model. Unavailable saved choices remain visible so you can repair them.

Work agents and foreground skills use the chat's composer model. Their prompts, tool permissions, sampling and thinking settings remain configurable. Orchestrator boards retain their own model controls.

The full Routing screen also has a **Fallbacks** tab for shared backup models, enablement, cooldown, and backup order. Configuring a fallback is separate from selecting the chat model.

## Model pools

The model picker has a **Pools** tab beside **All**, **Local**, and **Cloud**. Choose a pool in the list to inspect its strategy, model lineup, and capacity, then choose **Use pool**. Search matches pool, model, provider, and assigned task type names. For Match the task pools, the inspector shows each model’s tier and specialty badges. Paused pools stay visible for editing. On narrow screens, the list appears above the inspector.

Choose **New pool** or **Edit** to configure a pool inside the picker. New pools start with the currently selected model when it is eligible. Add models, choose a strategy, and set **Slots** directly. Each model’s **⋯** menu offers reordering, pause, and removal. **Match the task** also exposes the evaluator, model tiers, and task type assignments. **Save** updates the shared pool without selecting it; **Save & use** saves and selects it. Changes stay in a draft until saved, and leaving an edited draft asks whether to discard it. Failed saves retain the draft. If another window changed the pools, **Reload pools** lets you discard the draft and review the latest configuration. **Pool options** contains enablement and deletion; deleting a pool asks for confirmation and keeps its models connected.

**Manage pools** opens the full Models page for pool configuration and live activity. The full page saves edits automatically; the picker uses explicit saves.

If a provider runs out of usage, the pool automatically continues with another eligible model using the existing task evaluation. Minnow remembers the affected allowance across chats, pools, and restarts, so other requests skip it too. Separate provider connections retain their own allowance state. Temporary rate limits use a short cooldown instead of being treated as spent usage.

**Live routing** shows **Out of usage**, the reset or retry time when known, and **Retry now**. A recovery attempt uses a real request; Minnow sends no background model requests to check the allowance. **Retry now** allows one attempt before the cooldown expires. Other requests continue using alternatives while recovery is checked. If no reset time is supplied, quota retries start after 15 minutes and back off to six hours after repeated refusals. Existing chats keep their successful replacement model. If every eligible entry is unavailable, the chat shows the blockers so you can change the pool or retry later. Completed tool work stays recorded when a response switches models.

Open **Models → Model pools** and choose **New model pool**. Name the pool, then use **Add models** to browse and search models from **My Models** and your connected providers. Choose **Add** beside each model you want; models already in the pool show **Added**. Choose **Done** to return to the lineup. Local llama.cpp and MLX runtime catalogs are represented by their weights in My Models, just as in the chat picker.

The **Model lineup** uses compact rows. Choose a model’s name to replace it through the shared searchable picker. A provider/model pair can appear only once in a pool. Drag its handle or press **Alt+↑ / Alt+↓** to change rank; the **⋯** actions menu also offers **Move up**, **Move down**, and **Remove from pool**. **Enabled / Paused** controls whether a model receives work. Set concurrent generation **Slots** directly (1–100). Removing an entry keeps the model in your library. Changes save automatically, with **Retry save** available if saving fails.


When a chat is assigned a My Models entry that is not loaded, Minnow loads it before generating. If another local model is still producing a response, the router waits for that work to finish, then unloads it if residency requires and loads the assigned weights. Idle TTL (twenty minutes) still applies. Cloud and LM Studio entries are unchanged.

**Prefer first** prefers the first eligible model with free capacity. **Share work** assigns new chats using rank weights: a three-entry router uses weights 3, 2, and 1. Once assigned, a chat keeps that model. If its model is busy, the chat waits in a FIFO queue even when another entry has capacity. If all entries are busy, new chats queue too. Streaming and non-streaming generations each occupy one slot.

**Match the task** chooses a model and reasoning level once for each chat. Choose a model in the shared **Task evaluator** dropdown. For an unlisted ID, expand **Use a model ID not listed here**, select its provider, enter its ID, and choose **Use evaluator**. A decision model such as TypeSafe Jev (`typesafe/jev-1.13` on OpenRouter) or Cloudflare Clef (on Workers AI or OpenRouter) answers through the Decisions API with real confidence scores, and any other chat model can judge too by answering as JSON — pick something small and fast. Each entry gets a **Tier** (Fast, Balanced, or Frontier); **Auto** guesses it from the model name. Each model’s compact settings row contains **Tier**, **Tasks**, and **Slots**. Open **Tasks** to assign one or more specialties: **General**, **Coder**, **UX Design**, **Debugging**, **Code Review**, **Planning**, **Research**, or **Writing**. Choose **Any task** to clear the specialties and accept every task type. **Done** closes the task selector; the row shows a summary of the assignments. General covers everyday questions and conversation; Any task allows the model to handle every category. On your first message, the evaluator reads your request and chooses a task type, tier, and reasoning level. The chat keeps that choice for follow-ups and tool rounds, including after a reload or restart. Open the composer model menu and choose **Re-evaluate** to request a fresh choice on your next message. The router prefers models assigned to that task type, then models accepting any task, then the remaining lineup. Within that group it uses the requested tier, or the nearest tier when none is eligible, preferring a stronger one, and sets reasoning to the closest level the model offers. The model stays assigned while eligible; an unavailable or failed model can still move to another entry. When a re-evaluation is unsure (below 55% confidence) the chat keeps its current task type, tier, and reasoning. The evaluator has up to four seconds for a decision model, 30 seconds for a chat model, or 60 seconds for a CLI model, including CLI startup. CLI evaluators require background use to be enabled in **Models → CLIs**. If the evaluator is unset, fails, or exceeds its time limit, the router keeps the last choice or uses rank order. That fallback stays in place until you choose Re-evaluate. A pinned override skips the evaluator.

While the evaluator runs, the composer's model label shows **Evaluating**. Its choice appears immediately, for example **High reasoning · deepseek-v4**. During re-evaluation, the current model and reasoning remain visible until the new choice arrives. If the provider does not advertise reasoning levels, the label shows the requested effort, for example **High requested**, and the provider uses its default. Models known to lack reasoning show **No reasoning**. Hover the label for the task type, evaluator, confidence, tier, requested effort, and explanation. The live view shows each chat's last judgment. The top-bar **Models** popover also shows pool coverage; expand a pool to inspect each model’s tier and task assignments, or choose **Manage pools** to edit them.

Pools appear in the normal model picker with a **Model pool** label. Selecting a pool in the composer remembers it for new chats across projects; existing chats keep their selection. A chat's picker shows the router and its current provider/model assignment after a request starts.

The live view shows active and queued chats, their target models, and slot usage. Inspect a model card for average generation latency, error rate, reported tokens, and estimated cost when provider pricing and token counts are available. The chat's override selector pins an entry until you choose **Model pool assignment** to clear it. An override can fail over if its model fails; the replacement becomes sticky while the override remains marked until cleared.

Provider errors and unavailable models trigger failover. A response interrupted partway through restarts on another eligible entry with a visible warning; failed text, reasoning, and incomplete tool calls are discarded. Each request attempts a provider/model pair at most once. **Stop** cancels the request without failover. If no eligible entries remain, Minnow asks you to check the router's entries and provider configuration.

Pool configurations are shared across all workspaces. Assignments and evaluator decisions retain their individual chat or run identity. When enabled pools contain the same provider/model with different concurrency limits, admission uses the lowest configured limit across those pools. Activity and telemetry last for the current server session. On narrow screens the activity and model views stack; reduced-motion settings replace moving connections with static indicators.

**Pool active / Pool paused** enables or pauses the whole pool. Chats referencing a paused pool keep their selection and show its unavailable state. **Delete pool** asks you to confirm before removing the pool; it keeps the models in your library.

## Sampler

Temperature, top-p, top-k, min-p, repeat penalty, presence penalty, max tokens.

For a downloaded model, open its inspector and choose **Inference → Recommended preset**. Select a preset and click **Apply preset** to fill and save the recommended sampler values for that model. Every field stays editable, and your later changes are saved. Selecting a model or choosing a preset in the dropdown leaves your current values in place until you apply it.

Presets cover Qwen3, Qwen3.5, Qwen3.6, Qwen3.8 (including Flash Next), Qwen3 Coder Next, Gemma 4 instruction models, and DeepSeek R1 (including distills). The **Model guidance** link opens the official recommendation. Thinking and non-thinking presets describe the sampling to use with that mode; set the thinking mode separately in the composer or **Thinking** settings. Applying a preset preserves your output limit and any sampler fields the recommendation does not specify. Empty fields inherit global defaults. Models without a known recommendation keep the same editable fields.

For example, **Thinking / precise coding** for Qwen3.6 sets temperature **0.6**, top-p **0.95**, top-k **20**, min-p **0**, presence penalty **0**, and repeat penalty **1.0**. Explicit zero and neutral values override inherited sampling values on supported runtimes. Providers may support only some sampler parameters.

## Thinking

Reasoning mode and token budget for models that expose reasoning. Minnow displays reasoning separately from the answer and times it — the "Thinking…" clock covers reasoning only, stopping when tool calls begin, so the number means something.

For models that expose named reasoning levels, the model menu shows the available options in a **Reasoning** bar below the provider browser. The composer’s bar changes reasoning for the current chat, and its current level appears beside the model name. The default-model picker saves the choice for that provider and model, then applies it when you select it in a chat; choose **Default** to use the level advertised by the provider again.

## Usage & cost

Token totals for the active chat and for the workspace session. Enter per-million pricing for your models and it becomes actual spend rather than an abstract count.

## Voice

Built-in dictation automatically downloads a compact speech model on first use. System voices provide read-aloud without a model download. Optional larger **Whisper** and **Qwen3-TTS** models use the advanced local Python runtime; external voice providers are also supported.

See [Voice](../extend/voice.md).

## Choosing the model for a turn

| Control | Scope |
|---------|-------|
| **Composer picker, Ctrl+M / Cmd+M** | Selects this chat's model and remembers it for new chats across projects |
| **Issue / Dashboard launch picker** | Overrides the model for that dispatch |
| **Board model picker** | Selects that board's model |

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
