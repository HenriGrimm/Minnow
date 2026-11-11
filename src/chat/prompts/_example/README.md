# Minnow prompt system — contributor guide

## Where loaders scan

| Root | Purpose |
|------|---------|
| `src/chat/prompts/**` | Shipped defaults (bundled via Vite `import.meta.glob`) |
| `~/.minnow/prompts/**` | User overrides (same relative paths; same `id` wins) |

`_example/` is excluded from routing.

## Adding a prompt

1. Choose a subfolder: `base/`, `modes/`, `experts/`, `tool-usage/`, `info/`, etc.
2. Add `my-id.full.md`.
3. Set front matter `id`, `kind`, `label`, `version` — no central manifest required.
4. Run `npm test` — composer tests use fixtures under `__tests__/fixtures/`.

## Modules

| Module | Role |
|--------|------|
| `prompt-loader.ts` | Parse front matter, dual-root registry |
| `prompt-composer.ts` | `composeSystemPrompt()` — prompt composition |
| `compose-context.ts` | `buildComposeContext()` from config + tools |
| `interpolate.ts` | `{{token}}` replacement |
| `init-prompts.ts` | Boot from bundle + `GET /api/prompts/registry` |

Send path: `resolveComposedSystemPrompt()` in `compose-context.ts` → `buildApiMessages()` in `src/chat/build-api-messages.ts`.

## Forward references

| Step | Integration |
|------|-------------|
| 05 | `modes/*.md` + `modeId` in context |
| 06 | `experts/*.md` + auto/manual expert |
| 07 | `titles/` — separate from main compose |
| 08 | `work-agents/` + `workAgentId` |
| 13 | `skill` part + slash command body |
| 16 | `memory` part + retrieval block |
| 20 | Settings prompt editors |

See `PROMPT_TEMPLATE.md` in this folder for the full schema and tokens.
