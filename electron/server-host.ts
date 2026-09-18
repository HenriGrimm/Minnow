import http from 'node:http';
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

export async function startInProcessServer(): Promise<InProcessServerHandle> {
  const [
    { applyMinnowMiddlewares },
    { resolveSafePath, runWithPathAccess },
    { attachPtyWebSocketServer },
    { attachSttWebSocketServer },
    { attachTtsWebSocketServer },
    { attachAgentsWebSocketServer },
    { getAppRoot },
    { createSpaAuthHtmlMiddleware },
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
    importServerModule<{
      attachPtyWebSocketServer: (httpServer: http.Server) => void;
    }>('terminal/pty-ws.js'),
    importServerModule<{
      attachSttWebSocketServer: (httpServer: http.Server) => void;
    }>('stt/stt-ws.js'),
    importServerModule<{
      attachTtsWebSocketServer: (httpServer: http.Server) => void;
    }>('tts/tts-ws.js'),
    importServerModule<{
      attachAgentsWebSocketServer: (httpServer: http.Server) => void;
    }>('sub-agents/ws.js'),
    importServerModule<{ getAppRoot: () => string }>('workspace/root.js'),
    importServerModule<{
      createSpaAuthHtmlMiddleware: (options: { indexPath: string }) => connect.HandleFunction;
    }>('runtime/spa-auth-html.js'),
  ]);

  const connectApp = connect();

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
  attachPtyWebSocketServer(server);
  attachSttWebSocketServer(server);
  attachTtsWebSocketServer(server);
  attachAgentsWebSocketServer(server);

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

  return {
    url,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
