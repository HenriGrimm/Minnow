/** Isolated normal runtime, shared middleware registry, and real disk stores. */
import http from 'node:http';
import connect from 'connect';
import { ensureMinnowLayoutInitialized } from '../../server/config/home.js';
import { writeResource } from '../../server/config/store.js';
import { defaultServersConfig } from '../../server/config/validators.js';
import { bootstrapMinnowRuntime } from '../../server/runtime/bootstrap.js';
import { applyMinnowMiddlewares } from '../../server/runtime/middlewares.js';
import { resolveSafePath, runWithPathAccess } from '../../server/runtime/path-access.js';
import { getSessionToken } from '../../server/runtime/session-token.js';
import { createProvider } from '../../server/providers/store.js';
import { listGenerationStates } from '../../server/generations/store.js';

await ensureMinnowLayoutInitialized();
// An isolated fixture has no need to install or launch optional local daemons.
const servers = defaultServersConfig();
for (const row of Object.values(servers)) { row.enabled = false; row.autoStart = false; }
await writeResource('servers', servers);
await bootstrapMinnowRuntime();
try {
  await createProvider({ id: 'boundary-fixture', label: 'Boundary fixture', baseUrl: process.env.BOUNDARY_MODEL_URL, apiKind: 'openai-v1' });
} catch (error) {
  if (error.message !== 'Provider already exists') throw error;
}
let baseUrl;
let closeHost;
if (process.env.BOUNDARY_HOST_MODE === 'packaged') {
  // Run the emitted Electron host code, including its actual listeners and
  // WebSocket attachment. This verifies compiled-host parity, not an installer.
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  process.env.PORT = String(reservation.address().port);
  await new Promise(resolve => reservation.close(resolve));
  const { startInProcessServer } = await import('../../electron/dist/server-host.js');
  const handle = await startInProcessServer();
  baseUrl = handle.url.replace(/\/$/, '');
  closeHost = () => handle.close();
} else {
  const app = connect();
  applyMinnowMiddlewares(app, { resolveSafePath, runWithPathAccess });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  closeHost = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
}
process.send?.({ type: 'ready', baseUrl, token: getSessionToken() });
process.on('message', message => {
  if (message?.type === 'states') {
    process.send?.({ type: 'states', requestId: message.requestId, states: listGenerationStates().map(row => ({ id: row.id, status: row.status, totalBytes: row.totalBytes })) });
  } else if (message?.type === 'stop') {
    void closeHost().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  }
});
