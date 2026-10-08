import path from 'node:path';
import fs from 'node:fs/promises';
import { startProcess, killTree, command } from './process.js';
import { toolchainEnv } from './toolchain.js';
import { safePath, appRoot, readApp, serialize } from './store.js';
import { hostScript } from './host-scripts.js';

const running = new Map();
export async function startRuntime(root, dataDir, tools, signal) {
  await safePath(root); await safePath(dataDir);
  signal?.throwIfAborted();
  const host = await hostScript('runtime-host.mjs');
  const child = startProcess(tools.node, [host, '--serve', root, dataDir], { cwd: root, env: toolchainEnv(tools) });
  let stderr = '', output = '';
  const stop = () => killTree(child);
  signal?.addEventListener('abort', stop, { once: true });
  child.once('close', () => signal?.removeEventListener('abort', stop));
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('App did not start within 30 seconds')); }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); reject(new Error(`App exited before becoming ready: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      output = (output + chunk).slice(-8000);
      const match = /REEF_READY (http:\/\/127\.0\.0\.1:\d+\/a\/[a-f0-9]+\/)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  if (signal?.aborted) { stop(); throw signal.reason; }
  const health = await fetch(`${url}__health`, { signal: AbortSignal.timeout(10000) }).catch(error => { stop(); throw error; });
  if (!health.ok) { stop(); throw new Error('App health check failed'); }
  return { child, url, stop };
}
export async function launchApp(id, tools) {
  return serialize(`runtime:${id}`, () => launch(id, tools));
}
async function launch(id, tools) {
  const app = await readApp(id);
  if (!app.release) throw new Error('This app has no verified release');
  const existing = running.get(id);
  if (existing?.releaseId === app.release.id) return { url: existing.url };
  await stopApp(id);
  const root = await safePath(appRoot(id), 'releases', app.release.id);
  // Dependency folders are deliberately omitted from backups.
  try { await fs.access(path.join(root, 'node_modules')); }
  catch { await command(tools.node, [tools.npm, 'ci', '--omit=dev', '--ignore-scripts'], { cwd: root, env: toolchainEnv(tools) }); }
  const runtime = await startRuntime(root, await safePath(appRoot(id), 'data'), tools);
  const entry = { ...runtime, releaseId: app.release.id };
  running.set(id, entry);
  runtime.child.once('close', () => { if (running.get(id) === entry) running.delete(id); });
  return { url: runtime.url };
}
export async function stopApp(id) { const entry = running.get(id); running.delete(id); await entry?.stop(); }
export function stopAllApps() { for (const id of running.keys()) void stopApp(id); }
