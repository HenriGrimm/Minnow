# Tools and permissions

Choose how independently the agent can work using the permission control in the composer. This setting applies across chats, boards, and agent tools, including shell commands, browser actions, MCP servers, and plugins.

| Choose | Use it for |
| --- | --- |
| **Manual** | Review edits, commands, and actions outside the workspace as they come up. Routine local reads and searches can run. |
| **Auto** | Let routine in-workspace work proceed. Minnow asks about actions it classifies as risky, destructive, remote, or outside the workspace. |
| **Full access** | Give tools broad authority without routine prompts. Minnow still protects its secret stores. |

The limit captured for a running turn or delegated agent still applies. Send a new turn to use a higher level. For one task with narrower scope, start the turn with **/ask** for read-only work or **/plan** to allow plan writes under `documentation/plans/`. Issue tools can still manage issues during **/plan**, with deletion blocked.

## Decide on an approval

1. Read the requested action and reason. Expand **Review tool arguments** when available. Check the full command, path, URL, or integration and which checkout owns the request.
2. Select **Allow once** for the immediate call or **Deny** if the request differs from what you asked. When offered, **Allow for this chat** grants the displayed scope for the rest of that conversation.
3. To redirect the agent, use the feedback field on the card when available, or follow up with a narrower action. In a delegated run, **Activity → Needs you** opens the conversation that owns the request.

If a tool is missing, check its prerequisites. Browser tools need the desktop host. An MCP or plugin tool needs an enabled connection. Some tools load on demand, so tell the agent what capability to use. Use [Settings](../apps/settings.md) to find integration, shell sandbox, and filesystem controls.
