# Minnow prompt template reference

> Reference only — files under `_example/` are **not** loaded in production.

## Front matter (YAML)

```yaml
id: my-prompt-id          # required — unique slug; user overrides win on same id
kind: expert              # required — expert | mode | tool-usage | info | work-agent | title | base
label: Human label        # required — settings UI (Step 20)
version: 1                # required — bump on breaking edits
description: Optional note
part: expert              # optional — composer part id (defaults from kind)
modeBindings: [build, plan]
expertTriggers: [react, typescript]
toolPolicy: Optional hint for mode tool policy (Step 05)
body: |                   # optional inline body (alternative to markdown below)
  Multi-line body…
```

## When this prompt applies

| `kind` | Loaded when |
|--------|-------------|
| `base` | Always |
| `mode` | `ComposeContext.modeId` matches file / binding |
| `expert` | Manual or auto expert id (Step 06) |
| `work-agent` | Work agent active (Step 08) |
| `tool-usage` | Tools enabled for the session |
| `info` | Info preset id selected (`activeInfoPresetId`) |
| `skill` | Injected via `/skill` (Step 13) — not file-routed |
| `title` | Async title job only (Step 07) — not in main compose |

## Body sections (suggested)

1. **Role** — who the model is  
2. **Constraints** — scope, safety, output format  
3. **Tool rules** — only in `tool-usage` part (do not duplicate tool lists in `base`)  
4. **Examples** — optional

## Interpolation tokens

| Token | Source |
|-------|--------|
| `{{mode}}` | Active mode id |
| `{{expert}}` | Expert id / label |
| `{{cwd}}` | Project / page origin |
| `{{memory}}` | Retrieved memory block (Step 16) |
| `{{user_message}}` | Current turn preview |
| `{{chat_history_summary}}` | Optional summarizer |
| `{{work_agent}}` | Work agent id |
| `{{skill}}` | Skill body injection |
| `{{date}}` | ISO date |
| `{{os}}` | Platform string |

Unknown tokens remain literal and log once in the dev console.

## Composition

Parts concatenate in this order with `\n\n---\n\n`:

`base → mode → expert → work-agent → tool-usage → info → skill → memory`

## File layout

- Shipped: `src/chat/prompts/<kind>/…`
- User overrides: `~/.minnow/prompts/` (mirror tree; same `id` wins)
