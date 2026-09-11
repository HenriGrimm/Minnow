# Setup from source

Step-by-step guide to run Minnow from a git clone **for development**. End users should download a packaged build from [Releases](https://github.com/HenriGrimm/Minnow/releases) and follow [Install and first launch](../manual/get-started/install.md). Index: [`../README.md`](../README.md). Architecture orientation: [architecture.md](architecture.md). Exhaustive reference: [`../context.md`](../context.md).

## 1. Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 18+** (20+ recommended) | ES modules, Vite 6, native `node:test`. Check with `node -v`. |
| **npm** | Ships with Node. |
| **Git** | To clone and contribute. |
| **LM Studio** or another OpenAI-compatible provider | Needed to chat; the UI launches without one. |
| **Python 3** *(optional)* | Local voice (STT/TTS) only; provisioned on demand. |

Native modules (`better-sqlite3`, `@lydell/node-pty`) ship prebuilt binaries for common platforms. A C/C++ toolchain is only required if npm falls back to building from source.

## 2. Clone and install

```bash
git clone https://github.com/HenriGrimm/Minnow.git
cd Minnow
npm install
```

`postinstall` automatically:

- vendors the **Impeccable** UI-design skill into `src/skills/impeccable/` (`scripts/sync-impeccable-skill.mjs`) — the shipped copy Minnow installs into `~/.minnow/skills/impeccable/` at runtime, and
- ensures the **Electron** binary is present (`scripts/ensure-electron.mjs`).

Both are idempotent — safe to re-run.

### Optional document parsers

PDF/Word/Excel attachment support comes from `optionalDependencies`, which install best-effort. If an attachment type fails, install it explicitly:

```bash
npm install pdf-parse mammoth officeparser
# xlsx is fetched from the SheetJS CDN per package.json
```

## 3. Start a model provider

You need at least one OpenAI-compatible endpoint. Easiest is **LM Studio**:

1. Install and open **[LM Studio](https://lmstudio.ai/)**.
2. Download and **load** a chat model.
3. Open the **Developer / Server** tab and **Start Server** (default `http://localhost:1234`).
4. Confirm the model is listed in LM Studio's server UI.

Alternatives — all configured in the **Models** app under **Providers**:

- **Ollama** — point Minnow at `http://localhost:11434/v1`.
- **llama.cpp `llama-server`** — or let the **Models** app download and serve a model for you.
- **Cloud APIs** — any OpenAI-compatible base URL + API key (stored encrypted).

### LM Studio headless (optional, for servers/CI)

```bash
curl -fsSL https://lmstudio.ai/install.sh | bash
export PATH="$HOME/.lmstudio/bin:$PATH"
lms daemon up && lms server start
lms get <model-name> -y
lms load <model-name> -y
```

## 4. Run Minnow

```bash
npm start
```

This starts Vite + the Node tool server on **port 9473** (or the next free port — watch the terminal) and launches the **Electron desktop shell**. It also prints `Minnow data: <path>` showing your `~/.minnow` home.

### Dev variants

| Command | When to use |
|---------|-------------|
| `npm start` | **Default.** Full stack: tool server, persistence, Electron. |
| `MINNOW_BROWSER=1 npm start` | System browser tab instead of Electron. |
| `BROWSER=none npm start` or `MINNOW_HEADLESS=1 npm start` | No auto-open (CI/headless). |
| `PORT=3000 npm start` | Custom port (PowerShell: `$env:PORT=3000; npm start`). |
| `npm run dev` | Vite-only UI/HMR — **no** file/git tools, terminal, or most APIs. |
| `npm run desktop` / `npm run electron:dev` | Vite + Electron HMR without full `server.js` bootstrap. |

> `PORT=5173` is deliberately ignored and coerced back to 9473 — 5173 is reserved for dev servers in your *workspace*, so agents can start a Vite app without colliding with Minnow.

> Use `npm start` (not `npm run dev`) whenever you need file/git tools, persistence, terminal, attachments, browser preview, or any of the apps.

### Health check

Every `/api/*` route requires the per-boot session token in `~/.minnow/session-token`:

```bash
curl -H "X-Minnow-Token: $(cat ~/.minnow/session-token)" http://localhost:9473/api/tools/ping
# {"ok":true}
```

```powershell
curl.exe -H "X-Minnow-Token: $(Get-Content $env:USERPROFILE\.minnow\session-token)" http://localhost:9473/api/tools/ping
```

A bare request without the header returns `401 Unauthorized` — that is the gate working, not a broken server.

## 5. First-run checklist in the UI

1. **Provider** — **Models → Providers**: confirm the base URL and that the provider is reachable.
2. **Model** — pick one from the menubar model chip (use refresh if empty). Vision tasks need a **VLM**; tool-calling models work best for agent turns.
3. **Mode** — composer: General / Build / Plan / Debug. (Orchestrate opens from the sidebar hub, not the composer picker.)
4. **Tools** — Settings → Tools & integrations → **Tools**: enable capabilities; set per-tool permission (`full` / `ask` / `off`). Server tools need `npm start` and a healthy tools ping.
5. **Workspace** — open **Code** and pick a project folder; file/git tools resolve under this root.

## 6. Optional contributor setup

- **WSL / Git Bash (Windows)** — Settings → General → Chat & terminal → **Default shell**. Git Bash appears when Git for Windows is installed; WSL distros appear when WSL is installed. Requires `npm start`.
- **Voice** — Models → Voice: local Whisper / Qwen3-TTS or provider APIs.
- **Memory & Brain** — the **Brain** app owns memory settings and embeddings.
- **MCP** — Settings → Tools & integrations → **MCP servers**: Context7 built in; add custom servers.
- **Skills** — Settings → Tools & integrations → **Skills** / **Skills Library**: 19 built-in skills ship in-tree, plus third-party `SKILL.md` packs.
- **Webhooks** — Settings → Tools & integrations → **Webhooks**: HMAC-signed outbound deliveries.

> **Compare, Benchmarking, and Experts** are release-gated off in this build — see [apps-and-routes.md](apps-and-routes.md).

## 7. Next steps

- [commands.md](commands.md) — scripts, tests, env vars
- [architecture.md](architecture.md) — three-process map
- [orchestrate-board-testing.md](orchestrate-board-testing.md) — board test harness
- [`../manual/reference/configuration.md`](../manual/reference/configuration.md) — `~/.minnow` layout
- [tool authoring](../plugins/tool-authoring.md), [agent packs](../agent-packs/README.md)
