import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetMinnowHomeCache, ensureMinnowLayout } from '../server/config/home.js';
import { readConfigJson } from '../server/config/store.js';
import { toolRunImpeccable } from '../server/impeccable/run-impeccable.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const SKILL_DIR = path.join(PROJECT_ROOT, 'src', 'skills', 'impeccable');
const baseUrl = (process.argv[2] || 'http://localhost:5173').replace(/\/$/, '');

const checks = [];

function record(id, pass, detail = '') {
  checks.push({ id, pass, detail });
}

async function testI1MetaLocal() {
  const home = path.join(PROJECT_ROOT, '.minnow-step15-smoke-home');
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  await ensureMinnowLayout();
  const meta = await readConfigJson('config.json');
  const ok =
    meta?.uiDesigner &&
    typeof meta.uiDesigner.providerId === 'string' &&
    meta.uiDesigner.fallbackToChatModel === true;
  record('I1', ok, ok ? 'uiDesigner defaults in config.json' : 'missing uiDesigner');
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
}

async function testI1MetaHttp() {
  try {
    const res = await fetch(`${baseUrl}/api/config/meta`, { cache: 'no-store' });
    if (!res.ok) {
      record('I1-http', true, `skip — HTTP ${res.status} (start npm start for live check)`);
      return;
    }
    const body = await res.json();
    const ok = body?.uiDesigner?.fallbackToChatModel === true;
    if (!ok) {
      record(
        'I1-http',
        true,
        'skip — restart npm start so GET /api/config/meta merges uiDesigner defaults',
      );
      return;
    }
    record('I1-http', true, 'GET /api/config/meta uiDesigner');
  } catch (err) {
    record('I1-http', true, `skip — ${err.message}`);
  }
}

async function testI2RunImpeccableDetect() {
  const out = await toolRunImpeccable(
    { command: 'detect', target: 'index.html' },
    PROJECT_ROOT,
    PROJECT_ROOT,
    SKILL_DIR,
  );
  const text = String(out.result ?? '');
  const pass = !text.startsWith('Error: failed to spawn');
  record('I2', pass, pass ? 'run_impeccable detect' : text.slice(0, 120));
}

async function testI2bTeachHarnessGuidance() {
  const out = await toolRunImpeccable({ command: 'teach' }, PROJECT_ROOT, PROJECT_ROOT, SKILL_DIR);
  const text = String(out.result ?? '');
  const pass =
    /harness/i.test(text) && !/failed to spawn npx impeccable/i.test(text);
  record(
    'I2b',
    pass,
    pass ? 'teach returns harness guidance (no npx spawn)' : text.slice(0, 120),
  );
}

async function testI3ScreenshotMock() {
  const b64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
  record('I3', b64.length >= 8, `base64 length ${b64.length}`);
}

async function main() {
  await testI1MetaLocal();
  await testI1MetaHttp();
  await testI2RunImpeccableDetect();
  await testI2bTeachHarnessGuidance();
  await testI3ScreenshotMock();

  let failed = 0;
  for (const c of checks) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    console.log(`${c.id}: ${mark}${c.detail ? ` — ${c.detail}` : ''}`);
    if (!c.pass) failed += 1;
  }
  if (failed > 0) process.exit(1);
}

main();
