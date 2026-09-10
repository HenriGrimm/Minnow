import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { openBrowser } from './scripts/open-browser.mjs';
import path from 'node:path';
import { attachPtyWebSocketServer } from './server/terminal/pty-ws.js';
import { attachSttWebSocketServer } from './server/stt/stt-ws.js';
import { attachTtsWebSocketServer } from './server/tts/tts-ws.js';
import { destroyAllPtySessions } from './server/terminal/pty-host.js';
import { deleteGenerationsForProviderShutdown } from './server/generations/store.js';
import { getAppRoot } from './server/workspace/root.js';
import { getMinnowHome } from './server/config/home.js';
import { applyMinnowMiddlewares } from './server/runtime/middlewares.js';
import { getSessionToken } from './server/runtime/session-token.js';
import { createSpaAuthHtmlMiddleware } from './server/runtime/spa-auth-html.js';
import { bootstrapMinnowRuntime } from './server/runtime/bootstrap.js';
import {
  startSchedulerTickLoop,
  stopSchedulerTickLoop,
} from './server/scheduler/tick.js';
import { setSchedulerServerBaseUrl } from './server/scheduler/server-base-url.js';
import { shutdownSchedulerRuns } from './server/scheduler/runner.js';
import { shutdownAllServers, shutdownAllServersNow } from './server/servers/index.js';
import { shutdownAllModelServes } from './server/models/index.js';
import {
  resolveSafePath,
  runWithPathAccess,
} from './server/runtime/path-access.js';
import { readConfigJson } from './server/config/store.js';
import {
  initNetworkAccess,
  resolveNetworkAccess,
  resolveViteHost,
} from './server/network/access.js';

import { resolveMinnowPort } from './server/constants/minnow-port.js';
import {
  clearDevHostState,
  writeDevHostState,
} from './server/runtime/dev-host-state.js';
import { shutdownAgentBrowserService } from './server/browser-agent-api.js';

const PORT = resolveMinnowPort();

// ── Crash log ────────────────────────────────────────────────────────────────

/**
 * @param {{ kind: string, message: string, stack?: string }} entry
 */
function logServerCrash(entry) {
  try {
    const dir = path.join(getMinnowHome(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      source: 'dev-server',
      ...entry,
    });
    fs.appendFileSync(path.join(dir, 'crash.jsonl'), `${line}\n`, 'utf8');
  } catch {
  }
}

process.on('uncaughtException', (err) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logServerCrash({ kind: 'uncaughtException', message, stack });
  console.error('[minnow] uncaughtException (kept alive):', err);
});

process.on('unhandledRejection', (reason) => {
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logServerCrash({ kind: 'unhandledRejection', message, stack });
  console.error('[minnow] unhandledRejection (kept alive):', reason);
});

// ── Electron ─────────────────────────────────────────────────────────────────

function launchElectronShell(port, localUrl, appRoot) {
  const launcher = path.join(appRoot, 'scripts', 'launch-electron-after-vite.mjs');
  const child = spawn(process.execPath, [launcher, '--port', String(port)], {
    cwd: appRoot,
    env: process.env,
    stdio: 'inherit',
    detached: true,
  });

  child.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[minnow] Electron launcher could not start (${message}); opening system browser.`);
    openBrowser(localUrl);
  });

  child.unref();
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  clearDevHostState();

  const appRoot = getAppRoot();
  const configMeta = (await readConfigJson('config.json')) ?? {};
  const networkAccess = resolveNetworkAccess(configMeta);
  initNetworkAccess(configMeta);

  const vite = await createServer({
    configFile: path.join(appRoot, 'vite.config.ts'),
    server: {
      port: PORT,
      strictPort: false,
      host: resolveViteHost(networkAccess),
    },
    plugins: [
      {
        name: 'minnow-api',
        configureServer(server) {
          if (server.httpServer) {
            attachPtyWebSocketServer(server.httpServer);
            attachSttWebSocketServer(server.httpServer);
            attachTtsWebSocketServer(server.httpServer);
          }
          applyMinnowMiddlewares(server.middlewares, {
            resolveSafePath,
            runWithPathAccess,
          });
          server.middlewares.use(
            createSpaAuthHtmlMiddleware({
              indexPath: path.join(appRoot, 'index.html'),
              transformHtml: (url, html) => server.transformIndexHtml(url, html),
            }),
          );
        },
      },
    ],
  });

  const { workspacePath, homePath } = await bootstrapMinnowRuntime();
  console.log(`Workspace: ${workspacePath}`);
  console.log(`Minnow data: ${homePath}`);

  await vite.listen();
  for (const url of [
    '/src/main.ts',
    '/src/ui/file-viewer.ts',
    '/src/ui/editor-language.ts',
  ]) {
    await vite.warmupRequest(url);
  }
  await vite.environments.client.waitForRequestsIdle();

  const urls = vite.resolvedUrls?.local ?? [`http://localhost:${PORT}/`];
  const localUrl = urls[0];
  const boundPort = Number(new URL(localUrl).port) || PORT;
  writeDevHostState({ localUrl, port: boundPort });
  getSessionToken();
  const networkUrls = vite.resolvedUrls?.network ?? [];
  console.log(`Minnow dev server: ${localUrl}`);
  if (networkAccess === 'lan') {
    if (networkUrls.length > 0) {
      console.log(`LAN access enabled — open from other devices:`);
      for (const url of networkUrls) {
        console.log(`  ${url}`);
      }
    } else {
      console.log('LAN access enabled — no external network interfaces detected');
    }
  }
  console.log(`Config API: ${localUrl.replace(/\/$/, '')}/api/config/ping`);
  console.log(`Providers API: ${localUrl.replace(/\/$/, '')}/api/providers`);
  console.log(`Generations API: ${localUrl.replace(/\/$/, '')}/api/generations`);
  console.log(`Research API: ${localUrl.replace(/\/$/, '')}/api/research`);
  console.log(`Work agents API: ${localUrl.replace(/\/$/, '')}/api/work-agents`);
  console.log(`Agent packs API: ${localUrl.replace(/\/$/, '')}/api/agent-packs`);
  console.log(`Tools API: ${localUrl.replace(/\/$/, '')}/api/tools/ping`);
  console.log(`Memory API: ${localUrl.replace(/\/$/, '')}/api/memory/ping`);
  console.log(`Brain API: ${localUrl.replace(/\/$/, '')}/api/brain/ping`);
  console.log(`Models API: ${localUrl.replace(/\/$/, '')}/api/models/ping`);
  console.log(`LSP API: ${localUrl.replace(/\/$/, '')}/api/lsp/status`);
  console.log(`MCP API: ${localUrl.replace(/\/$/, '')}/api/mcp/ping`);
  console.log(`Servers API: ${localUrl.replace(/\/$/, '')}/api/servers/ping`);
  console.log(`Skills API: ${localUrl.replace(/\/$/, '')}/api/skills`);
  console.log(`Preview API: ${localUrl.replace(/\/$/, '')}/api/preview/ping`);
  console.log(`Terminal API: ${localUrl.replace(/\/$/, '')}/api/terminal/run`);
  console.log(`Terminal PTY: ${localUrl.replace(/\/$/, '')}/api/terminal/ws?sessionId=…`);
  console.log(`Scheduler API: ${localUrl.replace(/\/$/, '')}/api/scheduler/ping`);
  const schedulerBaseUrl = localUrl.replace(/\/$/, '');
  setSchedulerServerBaseUrl(schedulerBaseUrl);
  await startSchedulerTickLoop({ baseUrl: schedulerBaseUrl });
  const onShutdown = async () => {
    clearDevHostState();
    stopSchedulerTickLoop();
    shutdownSchedulerRuns();
    await shutdownAllServers();
    await shutdownAllModelServes();
    await shutdownAgentBrowserService();
    destroyAllPtySessions();
    deleteGenerationsForProviderShutdown();
  };
  const onShutdownSync = () => {
    clearDevHostState();
    stopSchedulerTickLoop();
    shutdownSchedulerRuns();
    shutdownAllServersNow();
    void shutdownAllModelServes();
    void shutdownAgentBrowserService();
    destroyAllPtySessions();
    deleteGenerationsForProviderShutdown();
  };
  process.on('exit', onShutdownSync);
  process.on('SIGINT', () => {
    void onShutdown()
      .catch((err) => console.error('[shutdown]', err))
      .finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void onShutdown()
      .catch((err) => console.error('[shutdown]', err))
      .finally(() => process.exit(0));
  });
  if (process.env.MINNOW_HEADLESS === '1') {
    console.log('Headless: UI auto-open skipped (MINNOW_HEADLESS=1)');
  } else if (process.env.BROWSER === 'none' || process.env.MINNOW_ELECTRON === '1') {
  } else if (process.env.MINNOW_BROWSER === '1') {
    openBrowser(localUrl);
    console.log('Opened in system browser (MINNOW_BROWSER=1). Built-in Chromium preview uses the Electron shell by default.');
  } else {
    const port = new URL(localUrl).port || String(PORT);
    launchElectronShell(port, localUrl, appRoot);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
