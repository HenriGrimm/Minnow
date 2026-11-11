# Expert prompt template

Experts are domain personas injected into the system prompt **after** the operating mode and **before** work-agent / tool-usage parts.

## Layout

| Root | Path |
|------|------|
| Built-in | `src/chat/prompts/experts/<id>/` |
| User override | `~/.minnow/prompts/experts/<id>/` (same `id` wins over built-in) |

Each expert folder needs:

- `expert.full.md` — full profile body + YAML front matter

## Summoning

Experts is a **hidden optional app** in default builds — not part of the eight released core apps. When enabled: open **Experts** (`#/experts`, top bar flask icon), pick a specialist, and run a brief. Disable the feature in Settings → Experts with **Enable experts**.

## Front matter

Use flat scalars in YAML (see `EXPERT_TEMPLATE.md`):

- `description` — one-line picker summary
- `tagline` — short subtitle under the label on tiles
- `greeting` — opening line when the expert is summoned
- `icon` — emoji or short glyph (optional)
- `accent` — theme token: `sage`, `amber`, `cyan`, `coral`, `violet`, `rose`

Do **not** add Auto-routing fields (`keywords`, `regex`, `negativeKeywords`, `classifierHint`, `priority`, `default`) or `version` on new experts.

Copy `example.full.md`, rename folder to your `id`, and restart or refresh the app.
