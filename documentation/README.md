# Minnow documentation

Everything written down about Minnow — the free and open source, full agentic development workspace — in one index.

## Using Minnow

In-app help: menubar **?** → `#/wiki` ( **`documentation/manual/`** plus roadmap). GitHub Wiki: full tree including **contributor/**, **context.md**, and maintainer runbooks.

| Doc | What's in it |
|-----|--------------|
| [Minnow manual](manual/README.md) | Install, Code, chat, shortcuts, data, troubleshooting (canonical for users, describes what ships today). |
| [Roadmap](ROADMAP.md) | Active direction and what is still being built (also in-app). |
| [Guides index](guides/README.md) | Redirect stubs for stable GitHub links → manual or contributor. |

## Building & contributing

| Doc | What's in it |
|-----|--------------|
| [Contributor index](contributor/README.md) | Setup from source, commands, architecture, board testing, a11y, LAN. |
| [Setup from source](contributor/setup-from-source.md) | Clone, install, providers, `npm start`, dev variants. |
| [Commands](contributor/commands.md) | Every npm script, headless CLI, test suites, environment variables. |
| [Architecture](contributor/architecture.md) | The three processes, SPA, tool server, agent layer. |
| [context.md](context.md) | Complete technical reference: every subsystem, API, and store. |
| [Tool authoring](plugins/tool-authoring.md) | Local tool plugins for `~/.minnow/tools/`. |
| [Agent packs](agent-packs/README.md) | Bundle prompts and agents for sharing. |
| [Design system](design-system/README.md) | `--mn-*` tokens, primitives, themes. |
| [DESIGN.md](../DESIGN.md) | Palette, typography, elevation, component rules. |
| [PRODUCT.md](../PRODUCT.md) | Who it's for, design principles. |
| [AGENTS.md](../AGENTS.md) | Orientation for AI coding agents in this repo. |

## Maintaining Minnow

| Doc | What's in it |
|-----|--------------|
| [Maintainer index](maintainer/) | Release, signing, wiki publishing, settings inventory. |
| [Releasing](maintainer/releasing.md) | Versioning, packaging, auto-update feed. |
| [Release notes](releases/) | Per-version notes for GitHub (`v0.0.1.md`, `v0.0.2.md`, …). |
| [macOS signing](maintainer/macos-signing.md) | Notarization and entitlements. |
| [Wiki publishing](maintainer/wiki-publishing.md) | GitHub Wiki staging from `documentation/`. |
| [Settings reference](maintainer/settings-reference.md) | Exhaustive settings and env inventory. |
| [Prompt ownership matrix](maintainer/prompt-ownership-matrix.md) | Who owns which prompts. |

## Working folders

Inputs to tools and agents — not primary reading:

- [`plans/`](plans/) — feature plans (Plan mode writes under `documentation/plans/` in your workspace too).
- [`schemas/`](schemas/), [`templates/`](templates/), [`specs/`](specs/) — JSON schemas and scaffolding.
- [`memory/`](memory/), [`MEMORY.md`](MEMORY.md) — curated notes for agents on Minnow itself.
- [`archive/`](archive/) — migration snapshots and shipped one-off plans.
- [`images/`](images/) — README screenshots.
