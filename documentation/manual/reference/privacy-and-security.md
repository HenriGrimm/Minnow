# Check where your data goes

## Before sending a prompt

Check the model in the composer and the helper bindings in **Models → Routing**. A cloud model or cloud-connected CLI receives the prompt and the context needed for the request, which can include attached images, repository text, tool results, and retrieved Brain pages. A local model can still call a network tool when permitted.

Web search, MCP servers, plugins, webhooks, Git remotes, and external voice providers can send data to their configured destinations. Review the tool and its input before approving a call. For a local-only task, choose a local model and scope the prompt and permissions to local files.

## Protect access to your profile

- Desktop access starts on loopback. Enable phone access under **Settings → General → Devices** and disconnect a paired device there if it is lost. Paired devices use the same tool permissions as the desktop.
- Open **Settings → Data and privacy → Access** to review filesystem and shell sandbox settings. The [composer permission control](../concepts/tools-and-permissions.md) governs agent actions.
- Treat downloaded extensions and local MCP commands as code you run on your machine. Inspect their source and connection scopes before installing.
- Keep API keys out of prompts and Brain. Minnow encrypts stored credentials using `.key` in [Minnow home](configuration.md). Use a passphrase-protected [backup](backup-and-restore.md) to carry those credentials between computers.

If a web page, document, or tool result asks the agent to disclose files or run an unrelated command, deny that action and restate the task. Check source control before sharing code and review diagnostic reports before posting them.
