# Contributing to Minnow

Documentation for cloning the repo, running from source, testing, and understanding the architecture. End-user help lives in [`../manual/`](../manual/) (in-app **?** wiki).

## Start here

| Doc | What it covers |
|-----|----------------|
| [setup-from-source.md](setup-from-source.md) | Clone, `npm install`, providers, `npm start`, dev variants, health checks |
| [commands.md](commands.md) | npm scripts, headless CLI, test suites, environment variables |
| [architecture.md](architecture.md) | SPA, tool server, Electron shell, agent layer — orientation before `context.md` |
| [apps-and-routes.md](apps-and-routes.md) | App registry, hash routes, release gate, per-app internals |

## Deep dives

| Doc | What it covers |
|-----|----------------|
| [orchestrate-board-testing.md](orchestrate-board-testing.md) | `test:orchestrator`, fake model, scenario contract, journal suite |
| [accessibility-audit.md](accessibility-audit.md) | Keyboard-first checklist, focus, screen readers, contrast regression |
| [remote-devices.md](remote-devices.md) | Phone access: ingress listeners, device credentials, connecting, built-in Tailscale |

## Related references

| Resource | Role |
|----------|------|
| [`../context.md`](../context.md) | Authoritative technical reference — APIs, stores, every subsystem |
| [`../maintainer/`](../maintainer/) | Releases, signing, settings inventory, wiki publishing |
| [`../design-system/`](../design-system/) | `--mn-*` tokens, primitives, themes |
| [`../plugins/tool-authoring.md`](../plugins/tool-authoring.md) | Local tool plugins in `~/.minnow/tools/` |
| [`../agent-packs/README.md`](../agent-packs/README.md) | Portable prompt/agent bundles |
| [`../../AGENTS.md`](../../AGENTS.md) | Orientation for AI coding agents |
| [`../../DESIGN.md`](../../DESIGN.md) | Visual design rules |
| [`../../PRODUCT.md`](../../PRODUCT.md) | Product principles |

Full documentation index: [`../README.md`](../README.md).
