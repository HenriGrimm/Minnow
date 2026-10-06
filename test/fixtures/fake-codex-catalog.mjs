#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

const home = process.env.CODEX_HOME;
const trace = process.env.CODEX_CATALOG_TRACE;
const inheritedCache = await fs.readFile(path.join(home, 'models_cache.json'), 'utf8').catch(() => null);
const auth = await fs.readFile(path.join(home, 'auth.json'), 'utf8').catch(() => null);
if (trace) await fs.appendFile(trace, `${JSON.stringify({ home, inheritedCache, auth, args: process.argv.slice(2) })}\n`);
const lines = createInterface({ input: process.stdin });
let initialized = false;
let acknowledged = false;
const respond = row => process.stdout.write(`${JSON.stringify(row)}\n`);
lines.on('line', async line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') { initialized = true; respond({ id: request.id, result: {} }); }
  else if (request.method === 'initialized') acknowledged = initialized;
  else if (request.method === 'model/list' && acknowledged) {
    if (process.env.CODEX_CATALOG_HANG) return;
    if (process.env.CODEX_CATALOG_SCENARIO === 'malformed') { respond({ id: request.id, result: { data: {} } }); return; }
    if (process.env.CODEX_CATALOG_SCENARIO === 'error') { respond({ id: request.id, error: { code: -32603, message: 'secret-must-not-appear' } }); return; }
    await fs.writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'cli-model', context_window: 272000 }] }));
    respond({ id: request.id, result: { data: [{ id: 'cli-model', model: 'cli-model', displayName: 'CLI Model',
      defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }] }],
      nextCursor: process.env.CODEX_CATALOG_SCENARIO === 'cycle' ? 'same-cursor' : null } });
  } else respond({ id: request.id, error: { message: 'Unexpected discovery request' } });
});
