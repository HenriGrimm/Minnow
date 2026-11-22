import './json-runtime.js';
import { flushCrashLogSync, logCrash } from './crash-log.js';
import { importServerModule } from './server-import.js';
import { startInProcessServer, type InProcessServerHandle } from './server-host.js';

const parent = process.parentPort;
if (!parent) throw new Error('The desktop backend requires an Electron parent process.');

let host: InProcessServerHandle | undefined;
let stopping = false;
const startup = start();

parent.on('message', ({ data }) => {
  if (data?.type !== 'shutdown' || stopping) return;
  stopping = true;
  void startup.then(stop).then(
    () => process.exit(0),
    error => {
      recordFailure('backend-shutdown-failed', error);
      process.exit(1);
    },
  );
});
void startup.catch(error => {
  recordFailure('backend-startup-failed', error);
  process.exit(1);
});

function recordFailure(kind: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logCrash({ source: 'child', kind, message, stack: error instanceof Error ? error.stack : undefined });
  flushCrashLogSync();
  console.error('[backend]', kind, error);
}

async function start(): Promise<void> {
  const { setAppRoot } = await importServerModule<{
    setAppRoot: (dir: string, options: { packaged: boolean }) => void;
  }>('workspace/root.js');
  const [appRoot, mode] = process.argv.slice(2);
  if (!appRoot || (mode !== 'packaged' && mode !== 'unpackaged')) {
    throw new Error('Missing desktop backend app root.');
  }
  setAppRoot(appRoot, { packaged: mode === 'packaged' });
  const { bootstrapMinnowRuntime } = await importServerModule<{
    bootstrapMinnowRuntime: () => Promise<unknown>;
  }>('runtime/bootstrap.js');
  await bootstrapMinnowRuntime();
  const { getSessionToken } = await importServerModule<{ getSessionToken: () => string }>(
    'runtime/session-token.js',
  );
  const token = getSessionToken();
  if (stopping) return;
  host = await startInProcessServer();
  if (!stopping) parent!.postMessage({ type: 'ready', url: host.url, token });
}

async function stop(): Promise<void> {
  try {
    await settleCleanup([
      importServerModule<{ stopBackupScheduleLoop: () => void }>('backup/schedule.js')
        .then(mod => mod.stopBackupScheduleLoop()),
      host?.close() ?? Promise.resolve(),
    ]);
    await settleCleanup([
      importServerModule<{ shutdownAllModelServes: () => Promise<void> }>('models/index.js')
        .then(mod => mod.shutdownAllModelServes()),
      importServerModule<{ shutdownAgentBrowserService: () => Promise<void> }>('browser-agent-api.js')
        .then(mod => mod.shutdownAgentBrowserService()),
      importServerModule<{
        disposeCodexSessions: (filter: () => boolean, options: { reason: string }) => Promise<void>;
      }>('generations/codex-app-server/lifecycle.js')
        .then(mod => mod.disposeCodexSessions(() => true, { reason: 'Minnow closed while this turn was running.' })),
    ]);
    await settleCleanup([
      importServerModule<{ destroyAllPtySessions: () => void }>('terminal/pty-host.js')
        .then(mod => mod.destroyAllPtySessions()),
      importServerModule<{ deleteGenerationsForProviderShutdown: () => void }>('generations/store.js')
        .then(mod => mod.deleteGenerationsForProviderShutdown()),
      importServerModule<{ shutdownAllServers: () => Promise<void> }>('servers/index.js')
        .then(mod => mod.shutdownAllServers()),
      importServerModule<{ shutdownAllLsp: () => void }>('lsp/manager.js')
        .then(mod => mod.shutdownAllLsp()),
      importServerModule<{ reloadMcp: () => Promise<void> }>('mcp/registry.js')
        .then(mod => mod.reloadMcp()),
    ]);
  } finally {
    const { closeSessionsDb } = await importServerModule<{ closeSessionsDb: () => void }>(
      'config/sessions-db.js',
    );
    closeSessionsDb();
  }
}

async function settleCleanup(tasks: Promise<unknown>[]): Promise<void> {
  for (const result of await Promise.allSettled(tasks)) {
    if (result.status === 'rejected') recordFailure('backend-cleanup-failed', result.reason);
  }
}
