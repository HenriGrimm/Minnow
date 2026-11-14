# Setup from source

Run Minnow from a Git clone for development. To use a packaged build, follow [Install and open a workspace](../manual/get-started/install.md). For implementation details, see the [architecture overview](architecture.md) and [technical reference](../context.md).

## 1. Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 24** | Matches the version in CI. Check with `node -v`. |
| **npm** | Ships with Node. |
| **Git** | To clone and contribute. |
| **LM Studio** or another OpenAI-compatible provider | Needed to chat; the UI launches without one. |
| **Python 3** *(optional)* | Local voice (STT/TTS) only; provisioned on demand. |

Native modules (`better-sqlite3`, `@lydell/node-pty`) ship prebuilt binaries for common platforms. A C/C++ toolchain is only required if npm falls back to building from source.

## 2. Clone and install

```bash
git clone https://github.com/HenriGrimm/Minnow.git
cd Minnow
npm ci
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

- **Ollama** — point Minnow at `http://localhost:11434`.
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

`npm start`, `npm run desktop`, and `npm run electron:dev` save server and Electron output under `~/.minnow/logs/runtime/server/` and `~/.minnow/logs/runtime/electron/` (or your `MINNOW_HOME`). Each run has `stdout.log`, `stderr.log`, and `events.log` files prefixed with its timestamp and supervisor PID. Check the newest stderr and events files after an unexpected exit; events include child PIDs, exit codes, and signals. Previous runs survive restart. Files rotate at 4 MiB with two backups, and old inactive runs are pruned on startup to retain ten runs, plus older live supervisors. Logging starts on the next launch after updating source. These logs are local and may contain application output; review them before sharing.

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

## 5. Verify the Graphite build

1. Open a project folder from **Choose a workspace**, or use **Sandbox** for a temporary project.
2. Select **New thread** in the workspace sidebar. Choose a connected model in the composer and follow [the first-change walkthrough](../manual/get-started/first-chat.md).
3. Open the **Side panel** and choose **Files** or **Diff**. Use **Bottom panel** to open Terminal. If tools fail across features, search Settings for **Health and diagnostics**, then check the tool server logs.

## 6. Configure optional services

- **Windows shells** live under **Settings → Code and workspace → Terminal**. Install Git for Windows for Git Bash or set up WSL for its distros.
- **Voice** lives under **Models → Voice**. **Brain → Settings** controls its own memory and embeddings.
- **MCP servers**, **Skills Library**, and **Webhooks** live under **Settings → Extensions**.

## 7. Next steps

- [commands.md](commands.md) — scripts, tests, env vars
- [architecture.md](architecture.md) — three-process map
- [orchestrate-board-testing.md](orchestrate-board-testing.md) — board test harness
- [`../manual/reference/configuration.md`](../manual/reference/configuration.md) — `~/.minnow` layout
- [tool authoring](../plugins/tool-authoring.md), [agent packs](../agent-packs/README.md)
