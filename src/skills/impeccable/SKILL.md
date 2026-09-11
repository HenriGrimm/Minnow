---
name: impeccable
description: Design, critique, audit, and refine Minnow UI using PRODUCT.md, DESIGN.md, and .impeccable/design.json. Not for backend-only tasks.
disable-model-invocation: true
---

# Impeccable (Minnow)

Design and iterate Minnow’s frontend using **project context files** and vendored Impeccable command references. Do not invent product facts or duplicate token tables from memory.

**Skill files** are installed at `{{skill_dir}}` (`reference/`, `scripts/`). Read and run them from there — never search the workspace or the Minnow app bundle (`app.asar`) for them.

**UI Designer (Step 15)** may invoke this skill automatically for critique → shape → implement flows.

## Context gate (required before UI edits)

Load product + design context in one JSON blob (no `head` / `grep` / `jq` on output):

**In Minnow (preferred):** call the `load_impeccable_context` tool. It runs the installed skill script and reads `PRODUCT.md`, `DESIGN.md`, and optionally `.impeccable/design.json` from the **active workspace**. The tool always succeeds when markdown context exists; check **`hasDesignJson`**. When it is `false`, run **`/impeccable document`** before token-critical critique or component work that needs the sidecar.

**Manual fallback** (run from the workspace root):

```bash
node src/skills/impeccable/scripts/minnow-context.mjs
```

The script reads the current directory; set `IMPECCABLE_CONTEXT_DIR` to point it at a monorepo sub-app instead.

| File | Role |
|------|------|
| `PRODUCT.md` | Users, register (`product`), tone, anti-references |
| `DESIGN.md` | Human design spec (Bench Instrument north star) |
| `.impeccable/design.json` | Structured tokens (`schemaVersion: 2`) when present; absent until `/impeccable document` |
| `src/styles/tokens.css` | Runtime CSS variables — edit tokens here, not hardcoded hex in components |
| `index.html`, `src/styles/*.css`, `src/ui/**` | Implementation targets |

When **`hasDesignJson`** is true, read **`designJson`** from the tool payload for machine-readable roles and bindings. When false, use `DESIGN.md` frontmatter and run `/impeccable document` to generate the sidecar before deep token work.

## Harness vs CLI

| Path | Use for | How in Minnow |
|------|---------|----------------|
| **Harness** | `init`, `audit`, `shape`, `craft`, `polish`, `critique`, `document`, `extract`, … | `/impeccable <cmd>` — loads `reference/<cmd>.md` (auto-injected in chat; `/impeccable craft` also injects `shape.md`) |
| **Harness alias** | `teach` → `init` | `/impeccable teach` or `/impeccable init` — both resolve to `reference/init.md` |
| **CLI** | `detect` | `npm run impeccable:detect` or `run_impeccable` with `command: detect` (omitted `target` scans `src/ui`, `src/styles`, and `index.html` when they exist — not the whole repo; URLs are rejected) |
| **Scripts** | `live` | `run_impeccable` with `command: live`; other scripts via `node src/skills/impeccable/scripts/<name>.mjs` |

Do **not** use `npx impeccable init` (or other harness commands via CLI). Do **not** use `run_impeccable` for `init`, `audit`, `shape`, `craft`, `polish`, etc. — use the harness row above.

## Command routing

User may append a sub-command after `/impeccable` (e.g. `/impeccable polish sidebar`). **Load the matching reference** under `src/skills/impeccable/reference/` before acting:

| Sub-command | Reference |
|-------------|-----------|
| `audit`, `critique` | `reference/audit.md`, `reference/critique.md` |
| `shape`, `craft`, `polish` | `reference/shape.md`, `reference/craft.md`, `reference/polish.md` |
| `init`, `document`, `extract` | `reference/init.md`, `reference/document.md`, `reference/extract.md` |
| `live` | `reference/live.md` (needs dev server + HMR; limited in static-only workflows) |

Full upstream command list: see `SKILL.upstream.md` or https://impeccable.style/docs

Run anti-pattern scan when asked or before large UI PRs:

```bash
npm run impeccable:detect
```

## Minnow constraints (see DESIGN.md)

- **Register:** `product` in `PRODUCT.md` — tool UI, not marketing site.
- **Aesthetic:** Bench instrument — calm surfaces, ink accent, soft green user bubbles; no hero-metric cards or gradient text.
- **Typography:** JetBrains Mono for code/metrics; respect `DESIGN.md` scale.
- **Motion:** Subtle; honor `prefers-reduced-motion`.
- **Anti-patterns:** Follow `DESIGN.md` and `npm run impeccable:detect`; do not restate full OKLCH tables here.

## Tools

- **`load_impeccable_context`** — PRODUCT.md, DESIGN.md, optional `.impeccable/design.json` (required before UI edits).
- **`run_impeccable`** — spawnable commands only: **`detect`** (CLI anti-pattern scan) and **`live`** (HMR script from the installed skill). Harness commands (`init`, `audit`, `shape`, `craft`, …) are **not** valid here; use `/impeccable <cmd>` so references are injected into this skill body. **Design pass / `detect`:** omit `target` to scan UI roots (`src/ui`, `src/styles`, `index.html`); pass a file or folder to narrow; never pass `http(s)` URLs. A 60s timeout names the paths that were scanned. Exit code 2 (findings) is success, not a tool error.
- Read/write: `read_file`, `list_directory`, and other Minnow file tools for implementation.
- Optional: Minnow browser CDP tools for visual QA (Step 12).

## Maintenance

- Upstream `reference/` + `scripts/` sync: `npm run impeccable:sync`
- Update upstream + re-sync: `npm run impeccable:update`
- Install: Minnow copies this skill into `~/.minnow/skills/impeccable/` (rewriting repo-relative skill paths to point at that directory) and refreshes it whenever the shipped copy changes. Edits to the installed `SKILL.md` survive refreshes; `reference/` and `scripts/` are replaced.
