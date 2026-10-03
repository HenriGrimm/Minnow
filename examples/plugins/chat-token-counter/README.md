# Chat token counter

Install this folder through Settings → Plugins, or copy it into any workspace and ask `/build-plugin` to adapt it. It needs no tool permissions or credentials.

The trusted UI module adds a cumulative counter beside throughput in Code’s status bar and metrics strip, a Token usage app in the rail, menu and command palette entries, and `/tokens` (canonical `/plugin-chat-token-counter--tokens`). The slash command opens the app locally without calling the model. It reads the existing token ledger rather than adding streamed estimates or counting the same request twice. Chat totals include completed main, sub-agent, title and utility requests; clearing a chat resets them. Workspace totals sum the retained chats in the current workspace and exclude deleted chats. Provider requests without measurable usage are not counted. There is no separate durable plugin counter.

Disable or remove the plugin to remove its UI and subscriptions. After editing, review and reload the source. UI code runs in Minnow’s document with access to DOM and authenticated APIs; review it before trusting it.
