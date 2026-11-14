# Manage models, routing, and usage

Open **Models** from the command palette. To connect a provider for the first time, follow [Connect a model](../get-started/connect-a-model.md).

## Download, load, and unload a local model

1. In **Discover**, use the recommended list or search Hugging Face for a model. Inspect its available files and estimated memory fit at your intended context size. Choose a GGUF for llama.cpp, or an MLX model for Apple Silicon.
2. Download the variant and watch its progress in the download shelf. To use an existing model file, add its folder in **Storage** and check **My models**.
3. In **My models**, open the model and its load settings. Start with a context that fits your hardware, then select **Load**.
4. Open **Local server** to see whether the runtime is starting or ready and to inspect logs. Select the ready model in the composer. Use **Unload** to free its memory.

If loading fails, keep the model selected in **Local server** while you read the log. Missing GGUF shards, an incompatible runtime, and memory exhaustion call for different fixes. For memory pressure, lower the context or load a smaller model. For a split GGUF, keep every shard together.

## Providers and subscriptions

Use **Providers** to manage API endpoints, keys, and model discovery. Use **Subscriptions** for the supported installed agent CLIs. Verify the model appears on the expected provider before selecting it. Pick it in the composer or press **Ctrl+M** / **Cmd+M**. Your selection becomes the starting choice for new ordinary threads. Existing threads keep their saved model.

## Routing

Open **Routing** to assign a different model to utility tasks or sub-agents. Utility tasks include titles, prompt or issue expansion, and commit messages. Without a fixed utility binding, the originating model supplies that role. Sub-agents inherit the parent model unless the delegation, agent type, or routing sets an override. Boards have model controls of their own.

Use **Sampling and thinking** when you need to adjust inference settings. Change one setting and repeat the same test prompt so you can tell which adjustment helped.

## Model pools

Use **Model pools** to create a named group of eligible models and set each member's concurrency slots. Select the pool in the composer like a model. For a workspace default, use **Default for new chats**. Check the actual model on the run when diagnosing capacity waits or failover.

## Usage and cost

Open **Usage and cost** to see recorded usage. Add prices for a cost estimate and use the provider bill for the charged total. See [Choose how to run and pay for models](../get-started/costs-and-providers.md).
