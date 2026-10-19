import http from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import connect from 'connect';
import sirv from 'sirv';
import { importServerModule } from './server-import.js';
import { listenOnPreferredLoopback } from './loopback-listen.js';
import { resolveMinnowPort } from './minnow-port.js';

export interface InProcessServerHandle {
  url: string;
  close(): Promise<void>;
}

/** Register before listening so shutdown also owns sockets upgraded to WebSockets. */
export function createInProcessHttpServerCloser(server: http.Server): () => Promise<void> {
  const connections = new Set<Socket>();
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  return () => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    // closeAllConnections excludes upgraded sockets. Those keep server.close()
    // pending after the UI goes offline, preventing quitAndInstall from running.
    server.closeAllConnections();
    for (const socket of connections) socket.destroy();
  });
}

export async function startInProcessServer(): Promise<InProcessServerHandle> {
  const [
    { applyMinnowMiddlewares },
    { resolveSafePath, runWithPathAccess },
    { attachMinnowWebSockets },
    { tagServerIngress },
    { configureRemoteIngress, applyRemoteConfigAtBoot, shutdownRemoteIngress },
    { flushDeviceActivity },
    { getAppRoot },
    { createSpaAuthHtmlMiddleware },
    { readConfigJson },
    { initNetworkAccess },
    { startIsolatedPreviewHost, stopIsolatedPreviewHost },
    { startSchedulerForHost, stopSchedulerForHost },
    { startReefForHost, stopReefForHost },
    { stopExports },
  ] = await Promise.all([
    importServerModule<{
      applyMinnowMiddlewares: (
        connectApp: connect.Server,
        deps: {
          resolveSafePath: (userPath: string, options?: { write?: boolean }) => string;
          runWithPathAccess: <T>(fn: () => Promise<T>) => Promise<T>;
        },
      ) => void;
    }>('runtime/middlewares.js'),
    importServerModule<{
      resolveSafePath: (userPath: string, options?: { write?: boolean }) => string;
      runWithPathAccess: <T>(fn: () => Promise<T>) => Promise<T>;
    }>('runtime/path-access.js'),
    importServerModule<{ attachMinnowWebSockets: (server: http.Server) => void }>('runtime/ws-attach.js'),
    importServerModule<{
      tagServerIngress: (server: http.Server, kind: 'loopback') => http.Server;
    }>('network/ingress.js'),
    importServerModule<{
      configureRemoteIngress: (opts: { requestHandler: http.RequestListener }) => void;
      applyRemoteConfigAtBoot: () => Promise<void>;
      shutdownRemoteIngress: () => Promise<void>;
    }>('remote/ingress-manager.js'),
    importServerModule<{ flushDeviceActivity: () => void }>('auth/device-store.js'),
    importServerModule<{ getAppRoot: () => string }>('workspace/root.js'),
    importServerModule<{
      createSpaAuthHtmlMiddleware: (options: { indexPath: string }) => connect.HandleFunction;
    }>('runtime/spa-auth-html.js'),
    importServerModule<{ readConfigJson: (filename: string) => Promise<unknown> }>('config/store.js'),
    importServerModule<{
      initNetworkAccess: (configMeta: unknown) => void;
    }>('network/access.js'),
    importServerModule<{
      startIsolatedPreviewHost: () => Promise<void>;
      stopIsolatedPreviewHost: () => Promise<void>;
    }>('preview/isolated-host.js'),
    importServerModule<{
      startSchedulerForHost: (baseUrl: string) => Promise<void>;
      stopSchedulerForHost: () => void;
    }>('scheduler/host.js'),
    importServerModule<{ startReefForHost: (url: string) => Promise<void>; stopReefForHost: () => void }>('reef/supervisor.js'),
    importServerModule<{ stopExports: () => void }>('reef/exports.js'),
  ]);

  const configMeta = (await readConfigJson('config.json')) ?? {};
  initNetworkAccess(configMeta);

  const connectApp = connect();
  await startIsolatedPreviewHost();

  applyMinnowMiddlewares(connectApp, { resolveSafePath, runWithPathAccess });

  const distDir = path.join(getAppRoot(), 'dist');

  connectApp.use(
    createSpaAuthHtmlMiddleware({
      indexPath: path.join(distDir, 'index.html'),
    }),
  );

  connectApp.use(
    sirv(distDir, {
      single: true,
      dev: false,
    }),
  );

  const server = http.createServer(connectApp);
  // The desktop window's listener is loopback-only; phones arrive on the
  // separate home-network and tailnet listeners (server/remote/).
  tagServerIngress(server, 'loopback');
  const closeHttpServer = createInProcessHttpServerCloser(server);
  attachMinnowWebSockets(server);

  const preferredPort = resolveMinnowPort();
  // Prefer 9473 so Chromium localStorage (FOUC cache) keeps the same origin across launches.
  const bound = await listenOnPreferredLoopback(server, preferredPort);
  const url = `http://127.0.0.1:${bound.port}/`;
  if (bound.ephemeral) {
    console.warn(
      `Minnow preferred port ${preferredPort} was busy; in-process server using ephemeral ${bound.port}`,
    );
  }
  console.log(`Minnow in-process server: ${url}`);
  configureRemoteIngress({ requestHandler: connectApp as unknown as http.RequestListener });
  try {
    await applyRemoteConfigAtBoot();
  } catch (err) {
    console.warn('[remote] could not start remote access:', err);
  }

  // A scheduled run is a child process that calls back into this server, so the
  // loop starts only once it is listening. A scheduler that cannot start must
  // not take the whole app down with it.
  try {
    await startSchedulerForHost(url);
    await startReefForHost(url);
  } catch (err) {
    console.warn('[scheduler] could not start; scheduled jobs will not run:', err);
  }

  return {
    url,
    async close(): Promise<void> {
      stopSchedulerForHost();
      stopReefForHost();
      stopExports();
      flushDeviceActivity();
      try {
        await shutdownRemoteIngress();
        await closeHttpServer();
      } finally {
        await stopIsolatedPreviewHost();
      }
    },
  };
}
