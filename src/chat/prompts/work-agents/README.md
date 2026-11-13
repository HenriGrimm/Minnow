# Work Agents (Step 08)

Task-specific agents with their own system prompt bodies and optional provider/model bindings.

## Add a new agent

1. Create `src/chat/prompts/work-agents/<id>/agent.full.md` (see `WORK_AGENT_TEMPLATE.md`).
2. Add `<id>` to `registry.json` `ids` array (order = UI list order).
3. Restart `npm start` so the server registry picks up the new folder.

## Overrides

| Path | Purpose |
|------|---------|
| `~/.minnow/work-agents.json` | Per-agent `providerId`, `modelId`, `disabled`, `promptOverride` |
| `~/.minnow/prompts/work-agents/<id>/agent.full.md` | Prompt file override |

## APIs (`npm start`)

- `GET /api/work-agents` — list agents
- `GET /api/work-agents/:id` — one agent
- `PUT /api/work-agents/:id` — patch user override JSON
- `GET/PUT /api/work-agents/:id/prompt` — read/write prompt body

Client registry: `src/agents/work-agent-registry.ts`. Full settings UI: Step 20.
