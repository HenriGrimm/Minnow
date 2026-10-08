import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { readJsonBody, jsonBodyErrorStatus } from '../runtime/json-body.js';
import { resolveJobRunModel } from '../scheduler/resolve-job-model.js';
import { getActiveProviderId, getProvider } from '../providers/store.js';
import { readConfigJson } from '../config/store.js';
import { getSessionToken } from '../runtime/session-token.js';
import { listApps, readApp, createApp, updateApp, appRoot, safePath, validId, TERMINAL, boundedText, serialize } from './store.js';
import { reefSupervisor, chatAboutApp, appHasChat } from './supervisor.js';
import { launchApp, stopApp } from './runtime.js';
import { ensureToolchain } from './toolchain.js';
import { command } from './process.js';
import { readEvents, reefEvents, recordEvent } from './events.js';
import { queueExport, exportCapabilities, appHasExport } from './exports.js';

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function resolveModelBinding(input) {
  if (!reefSupervisor.baseUrl) throw new Error('Reef host is not ready');
  const binding = await resolveJobRunModel(input);
  if (!binding.modelId) throw new Error('Choose a model before building');
  binding.providerId ||= await getActiveProviderId();
  const provider = await getProvider(binding.providerId);
  if (!provider || provider.enabled === false) throw new Error('The selected model provider is unavailable');
  // CLI adapters hand tools back to the same Reef-restricted headless runner.
  // Probe the configured catalog before accepting an unattended job.
  const response = await fetch(new URL(`/api/providers/${encodeURIComponent(binding.providerId)}/models`, reefSupervisor.baseUrl), {
    headers: { 'X-Minnow-Token': getSessionToken() }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Model provider preflight failed (${response.status})`);
  const catalog = await response.json();
  if (catalog.unreachable) throw new Error(catalog.error || 'The model provider is unreachable');
  if (!Array.isArray(catalog.data) || !catalog.data.some(model => model.id === binding.modelId)) throw new Error('The selected model is unavailable. Choose an available model before building.');
  return binding;
}
async function preflight(input) {
  const binding = await resolveModelBinding(input);
  await command('git', ['--version'], { timeout: 10000 });
  const tools = await readConfigJson('tools.json');
  for (const name of ['read_file', 'save_file', 'list_directory', 'make_directory']) {
    if (tools?.enabled?.[name] === false || tools?.permissions?.default?.[name] === 'off') throw new Error(`Enable ${name} in Settings before building`);
  }
  await ensureToolchain({ signal: AbortSignal.timeout(180000) });
  return binding;
}

async function eventStream(id, req, res, url) {
  await readApp(id);
  let cursor = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  req.socket.setTimeout(0);
  const pending = [];
  let replaying = true, blocked = false;
  const outbound = [];
  const send = event => {
    if (event.id <= cursor || res.destroyed) return;
    if (blocked) {
      // Bound slow subscribers; reconnect can replay from their last received id.
      if (outbound.length >= 500) res.destroy(); else outbound.push(event);
      return;
    }
    cursor = event.id;
    blocked = !res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const drain = () => {
    blocked = false;
    while (outbound.length && !blocked && !res.destroyed) send(outbound.shift());
  };
  res.on('drain', drain);
  const receive = event => { if (replaying) pending.push(event); else send(event); };
  reefEvents.on(id, receive);
  const timer = setInterval(() => { if (!blocked && !res.destroyed) blocked = !res.write(': heartbeat\n\n'); }, 15000);
  const cleanup = () => { clearInterval(timer); reefEvents.off(id, receive); res.off('drain', drain); };
  res.once('close', cleanup);
  try {
    const history = await readEvents(id);
    if (history.length && cursor < history[0].id - 1) res.write('event: reset\ndata: {}\n\n');
    for (const event of history) send(event);
    replaying = false; for (const event of pending) send(event);
    res.write('event: snapshot\ndata: {}\n\n');
  } catch (error) { cleanup(); res.destroy(error); }
}

export function createReefMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/reef/')) return next();
    try {
      const parts = url.pathname.slice('/api/reef/'.length).split('/').filter(Boolean);
      if (parts[0] === 'ping') return json(res, 200, { ok: true });
      if (parts[0] === 'capabilities' && req.method === 'GET') return json(res, 200, await exportCapabilities());
      if (parts[0] !== 'apps') return json(res, 404, { error: 'Unknown Reef route' });
      if (parts.length === 1) {
        if (req.method === 'GET') return json(res, 200, await listApps());
        if (req.method === 'POST') {
          const input = await readJsonBody(req, 32000);
          const binding = await preflight(input);
          const app = await createApp({ ...input, ...binding });
          await reefSupervisor.enqueue(app.id, app.description);
          return json(res, 201, await readApp(app.id));
        }
      }
      const id = validId(parts[1]);
      const action = parts[2];
      if (!action) {
        if (req.method === 'GET') return json(res, 200, { ...await readApp(id), workspacePath: await safePath(appRoot(id), 'repo') });
        if (req.method === 'PATCH') {
          const input = await readJsonBody(req, 2000);
          return json(res, 200, await updateApp(id, app => { app.name = boundedText(input.name, 'Name', 100); }));
        }
        if (req.method === 'DELETE') {
          await serialize('reef-admission', async () => {
            const app = await readApp(id);
            if (app.runs.some(run => !TERMINAL.has(run.state)) || appHasExport(id) || appHasChat(id)) throw Object.assign(new Error('Cancel or finish active work before deleting this app'), { statusCode: 409 });
            await stopApp(id);
            await fs.rm(await safePath(appRoot(id)), { recursive: true, force: false });
          });
          return json(res, 200, { ok: true });
        }
      }
      if (action === 'events' && req.method === 'GET') return await eventStream(id, req, res, url);
      if (action === 'model' && req.method === 'PUT') {
        await readApp(id);
        const input = await readJsonBody(req, 2000);
        input.modelId = boundedText(input.modelId, 'Model', 1000);
        const binding = await resolveModelBinding(input);
        const app = await updateApp(id, current => { current.providerId = binding.providerId; current.modelId = binding.modelId; });
        await recordEvent(id, { type: 'model', ...binding });
        return json(res, 200, app);
      }
      if (action === 'preview' && req.method === 'GET') {
        const app = await readApp(id);
        if (!app.release) return json(res, 404, { error: 'No verified preview' });
        const file = await safePath(appRoot(id), 'runs', validId(app.release.id), 'preview.png');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(await fs.readFile(file)); return;
      }
      if (action === 'runs' && req.method === 'POST') {
        const input = await readJsonBody(req, 32000);
        const app = await readApp(id); await preflight(app);
        if (input.action !== undefined) return json(res, 202, await reefSupervisor.recover(id, validId(input.runId), input.action));
        if (!input.prompt && ['failed', 'cancelled', 'interrupted'].includes(app.runs.at(-1)?.state)) {
          return json(res, 202, await reefSupervisor.recover(id, app.runs.at(-1).id));
        }
        return json(res, 202, await reefSupervisor.enqueue(id, input.prompt || app.runs.at(-1)?.prompt || app.description));
      }
      if (action === 'cancel' && req.method === 'POST') {
        const input = await readJsonBody(req, 1000);
        await reefSupervisor.cancel(id, validId(input.runId)); return json(res, 200, { ok: true });
      }
      if (action === 'launch' && req.method === 'POST') return json(res, 200, await serialize('reef-admission', async () => launchApp(id, await ensureToolchain())));
      if (action === 'stop' && req.method === 'POST') { await stopApp(id); return json(res, 200, { ok: true }); }
      if (action === 'chat' && req.method === 'POST') {
        const input = await readJsonBody(req, 32000);
        return json(res, 200, await chatAboutApp(id, input.prompt));
      }
      if (action === 'exports' && req.method === 'POST') return json(res, 202, await queueExport(id, await readJsonBody(req, 2000)));
      if (action === 'exports' && parts[3] && req.method === 'GET') {
        const app = await readApp(id), item = app.exports.find(x => x.id === validId(parts[3]));
        if (!item || item.status !== 'ready' || !item.filename) throw new Error('Export is not ready');
        const file = await safePath(appRoot(id), 'exports', item.id, item.filename);
        const stat = await fs.stat(file);
        res.writeHead(200, { 'Content-Type': item.filename.endsWith('.gz') ? 'application/gzip' : item.filename.endsWith('.zip') ? 'application/zip' : 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="${item.filename}"` });
        const stream = createReadStream(file); stream.on('error', error => res.destroy(error)); res.once('close', () => stream.destroy()); stream.pipe(res); return;
      }
      return json(res, 405, { error: 'Unsupported Reef operation' });
    } catch (error) {
      if (!res.headersSent) json(res, error.code === 'ENOENT' ? 404 : jsonBodyErrorStatus(error), { error: String(error.message) });
      else res.destroy(error);
    }
  };
}
