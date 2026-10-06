# Third-party notices

Minnow is distributed under the **GNU Affero General Public License v3** (AGPL-3.0). The packaged desktop app bundles Node.js dependencies from this repository's `package.json` (plus Electron/Chromium for the shell). This file lists representative major components and UI asset licenses. It is **not** a complete SPDX inventory — run `npx license-checker --production` (or `--direct` for top-level deps) against an installed `node_modules` tree for the full dependency graph and license strings shipped in a given build.

## Application runtime (representative)

| Component | Role | License | Source |
|-----------|------|---------|--------|
| **Electron** | Desktop shell (Chromium + Node) | MIT | https://github.com/electron/electron |
| **React** / **react-dom** | UI framework | MIT | https://github.com/facebook/react |
| **Vite** | Frontend build (artifacts in `dist/`) | MIT | https://github.com/vitejs/vite |
| **TypeScript** | Language tooling and compiler | Apache-2.0 | https://github.com/microsoft/TypeScript |
| **better-sqlite3** | Sessions and local SQLite stores | MIT | https://github.com/WiseLibs/better-sqlite3 |
| **express** | Tool server HTTP routing | MIT | https://github.com/expressjs/express |
| **connect** / **sirv** | Static asset and middleware serving | MIT | https://github.com/senchalabs/connect |
| **ws** | WebSocket transport | MIT | https://github.com/websockets/ws |
| **electron-updater** | In-app update downloads | MIT | https://github.com/electron-userland/electron-builder |
| **ai** (Vercel AI SDK) | Provider / streaming helpers | Apache-2.0 | https://github.com/vercel/ai |
| **CodeMirror** (`@codemirror/*`) | Code editor | MIT | https://github.com/codemirror |
| **@xterm/xterm** | Terminal emulator | MIT | https://github.com/xtermjs/xterm.js |
| **@xenova/transformers** | On-device embeddings (Brain) | Apache-2.0 | https://github.com/xenova/transformers.js |
| **highlight.js** | Syntax highlighting | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| **marked** | Markdown rendering | MIT | https://github.com/markedjs/marked |
| **DOMPurify** / **isomorphic-dompurify** | HTML sanitization | MIT | https://github.com/cure53/DOMPurify |
| **node-pty** / **@lydell/node-pty** | Interactive terminals | MIT | https://github.com/microsoft/node-pty |
| **@vscode/ripgrep** | Fast repo search | MIT | https://github.com/microsoft/vscode-ripgrep |
| Language servers (typescript-language-server, pyright, yaml-language-server, vscode-langservers-extracted, etc.) | Editor intelligence | MIT / Apache-2.0 | respective npm packages |

Bundled language-server and model-weight downloads may carry additional licenses in their own packages or downloaded artifacts.

## Material Icon Theme

Minnow uses **Material Icon Theme** (PKief / Material Extensions) for file and folder icons in the Code file tree and editor tabs.

- Package: https://www.npmjs.com/package/material-icon-theme
- Repository: https://github.com/material-extensions/vscode-material-icon-theme
- License: MIT (see `node_modules/material-icon-theme/LICENSE`)

Copyright (c) Material Extensions.

## Uicons (Flaticon)

Minnow uses **Uicons** from Flaticon for UI chrome icons (sidebar, composer, git toolbar, app launcher, and related surfaces).

- Package: https://www.npmjs.com/package/@flaticon/flaticon-uicons
- License: see Flaticon / Freepik license terms for the installed package version

Attribution: Uicons by [Flaticon](https://www.flaticon.com/uicons). Confirm paid-license coverage or keep this notice visible per your Flaticon plan.

## Provider logos

Provider marks in `public/logos/providers/` are from [Lobe Icons](https://github.com/lobehub/lobe-icons), licensed under MIT. The complete license is bundled in `public/logos/providers/LICENSE`. Names and logos are trademarks of their respective owners.
