# Mode prompt template pack

Reference stubs for **Build**, **Plan**, **Orchestrate**, and **Research** operating modes.

## Layout

| File | Purpose |
|------|---------|
| `MODE_TEMPLATE.md` | Commented reference for authors |
| `build.full.md` | Build mode bodies |
| `plan.*`, `orchestrate.*`, `research.*` | Other modes |

**Shipped runtime copies** live one level up: `src/chat/prompts/modes/{id}.full.md` (loader glob, no `_template/`).

## Add a new mode (future)

1. Add `ModeId` + `ModeDefinition` in `src/chat/modes/registry.ts`.
2. Add `modes/{id}.full.md` with front matter `kind: mode`.
3. Embed `<!-- MINNOW_MODE_MARKER: {id} full -->` in bodies.
4. Extend `test/modes/run-all.mts` cases.

## Tests

```bash
npx tsx test/modes/run-all.mts
```

User overrides: `~/.minnow/prompts/modes/{id}.full.md` (wins over built-in when `npm start` registry is loaded).
