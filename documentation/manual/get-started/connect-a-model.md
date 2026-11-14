# Connect a model

Open the command palette with **Ctrl+K** / **Cmd+K** and select **Go to Models**. Use one of these paths, then choose the model in a Code thread's composer. Start with a chat model that supports tool calls if you want it to read files, edit, or run tests.

## LM Studio

1. In [LM Studio](https://lmstudio.ai/), download a chat model and start its local API server. Load the model if it is not already loaded.
2. Open **Models → Providers** in Minnow. Check for the local LM Studio connection. If needed, add an OpenAI-compatible connection with the server's base URL, usually `http://127.0.0.1:1234`.
3. Refresh the provider and look for the model in the composer.

## Ollama

1. Start [Ollama](https://ollama.com/) and pull a chat model using `ollama pull MODEL`, replacing `MODEL` with the tag you want.
2. In **Models → Providers**, check for Ollama or add an OpenAI-compatible connection pointing to the local server, usually `http://127.0.0.1:11434`.
3. Refresh the connection and select the downloaded model in the composer.

## Serve a model inside Minnow

1. Open **Models → Discover** and look at the memory fit for the context size you intend to use.
2. Open a model, select the file or variant, and download it.
3. Open **My models**, select the downloaded model, and use **Load**. Check **Local server** for startup status and logs.
4. Return to the thread and select the model. If it fails to load, first try a smaller context or model.

## Cloud APIs

In **Models → Providers**, choose a preset or add your own connection. Use the provider's API base URL and key, then refresh. A cloud provider receives the request, including the project context you send with it. Check [what data can leave the machine](../reference/privacy-and-security.md) if the project contains sensitive files.

## Subscriptions

Open **Models → Subscriptions** to find supported installed CLIs such as Claude Code, Codex, and Cursor. Use **Install** if offered, then **Sign in** or **Verify** and enable the connection. The CLI's models appear in the composer picker after the connection is ready. Vendor account access and usage limits apply.

## When the picker stays empty

1. In **Models → Providers**, confirm that the connection is enabled and refresh its model list.
2. For a local connection, confirm the process is listening at the address you entered and has a model available. For cloud, check the base URL and API key. For a CLI, verify sign-in under **Subscriptions**.
3. Open the composer's model picker again. Search the model name or expand its provider. Press **Ctrl+M** / **Cmd+M** in Code to focus the model picker.

After you can select a model, [send your first prompt](first-chat.md). To use separate models for support tasks, see [Routing](../apps/models.md#routing).
