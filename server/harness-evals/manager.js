import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { getAppRoot } from '../workspace/root.js';
import { getProviderRuntime } from '../providers/store.js';
import { killProcessTree } from '../terminal-runner.js';

const exec = promisify(execFile);
const exists = async (name) => fs.access(name).then(() => true, () => false);

export function validateRun(body) {
  if (!body || typeof body !== 'object') throw new Error('Run options are required');
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model || model.length > 300 || /[\x00-\x1f]/.test(model)) throw new Error('Enter a valid model ID');
  if (typeof body.providerId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.providerId)) throw new Error('Choose a provider');
  if (!['smoke', 'pilot'].includes(body.preset)) throw new Error('Choose a trial size');
  const ranges = { attempts: [1, 5], max_steps: [1, 1000], max_tokens: [128, 131072], context_window: [1024, 1048576], timeout: [60, 7200] };
  const result = { model, smoke: body.preset === 'smoke' };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isInteger(body[key]) || body[key] < min || body[key] > max) throw new Error(`${key} must be between ${min} and ${max}`);
    result[key] = body[key];
  }
  if (result.max_tokens >= result.context_window) throw new Error('Output limit must be smaller than the context window');
  return result;
}

// One coordinator per server; navigation and page reloads do not start duplicate jobs.
export function createHarnessManager({ root = getAppRoot(), launch = spawn, provider = getProviderRuntime, kill = killProcessTree, probeCommand = exec } = {}) {
  const home = path.join(root, 'evals/harness');
  const records = path.join(home, 'artifacts/gui-runs');
  let active = null;
  let checking = null;
  let checks = null;
  let reserving = false;
  const available = () => exists(path.join(home, 'gui.py'));
  async function check() {
    if (checking) return checking;
    checking = (async () => {
      const probe = async (command, args) => {
        try { return (await probeCommand(command, args, { cwd: root, timeout: 10000, windowsHide: true, maxBuffer: 8192 })).stdout.trim(); }
        catch { return null; }
      };
      const [uv, git, node, docker] = await Promise.all([
        probe('uv', ['--version']), probe('git', ['--version']), probe('node', ['--version']),
        probe('docker', ['info', '--format', '{{.OSType}}']),
      ]);
      checks = { uv: !!uv, git: !!git, node: !!node, docker: docker === 'linux', checkedAt: new Date().toISOString() };
      return checks;
    })().finally(() => { checking = null; });
    return checking;
  }
  async function save(record) {
    await fs.mkdir(records, { recursive: true });
    const target = path.join(records, `${record.id}.json`);
    await fs.writeFile(`${target}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(`${target}.tmp`, target);
  }
  async function history() {
    const names = await fs.readdir(records).catch(() => []);
    const rows = [];
    for (const name of names.filter(n => /^gui-[\w-]+\.json$/.test(n)).sort().reverse().slice(0, 20)) {
      try {
        const row = JSON.parse(await fs.readFile(path.join(records, name), 'utf8'));
        if (row.status === 'running' && row.id !== active?.record.id) row.status = 'interrupted';
        row.summary = JSON.parse(await fs.readFile(path.join(home, 'artifacts', path.basename(row.id), 'jobs/summary.json'), 'utf8').catch(() => 'null'));
        rows.push(row);
      } catch { /* A damaged record must not hide the rest of the history. */ }
    }
    return rows;
  }
  async function status() {
    return { available: await available(), checks,
      installed: await exists(path.join(home, '.venv/pyvenv.cfg')),
      runtime: await exists(path.join(home, 'artifacts/minnow-runtime.tar.gz.json')),
      datasets: await exists(path.join(home, 'datasets/terminal-2.1/tasks')) && await exists(path.join(home, 'datasets/deepswe/tasks')),
      active: active ? { ...active.record, log: active.log } : null, history: await history() };
  }
  async function start(action, body = {}) {
    if (active?.record.status === 'running' || reserving) throw new Error('A benchmark operation is already running');
    if (!['setup', 'runtime', 'run'].includes(action)) throw new Error('Unknown benchmark action');
    reserving = true;
    try {
      if (!await available()) throw new Error('Harness benchmarks require a Minnow source checkout');
      let config;
      let headers = {};
      const env = { ...process.env, PYTHONUNBUFFERED: '1', NO_COLOR: '1' };
      // Explicit provider selection, never fall back to ambient evaluation credentials.
      delete env.MINNOW_EVAL_API_KEY;
      delete env.MINNOW_EVAL_HEADERS;
      delete env.MINNOW_EVAL_API_URL;
      const id = `gui-${Date.now()}-${randomUUID().slice(0, 8)}`;
      if (action === 'run') {
        config = { ...validateRun(body), name: id };
        const health = await check();
        if (!health.docker) throw new Error('Start Docker with Linux containers, then check setup again');
        if (!health.node || !health.uv || !health.git) throw new Error('Install Node, Git and uv, then check setup again');
        if (!await exists(path.join(home, '.venv/pyvenv.cfg'))) throw new Error('Install the evaluator first');
        if (!await exists(path.join(home, 'datasets/terminal-2.1/tasks')) || !await exists(path.join(home, 'datasets/deepswe/tasks'))) throw new Error('Download the benchmark datasets first');
        if (!await exists(path.join(home, 'artifacts/minnow-runtime.tar.gz.json'))) throw new Error('Build the benchmark runtime first');
        const { profile, paths, headers: auth } = await provider(body.providerId);
        if (profile.enabled === false || !['openai-v1', 'lm-studio-v0'].includes(profile.apiKind)) throw new Error('Choose an enabled Chat Completions provider');
        headers = auth;
        env.MINNOW_EVAL_API_URL = profile.baseUrl.replace(/\/+$/, '') + paths.chatCompletionsPath;
        env.MINNOW_EVAL_HEADERS = JSON.stringify(headers);
      }
      const args = action === 'setup'
        ? ['sync', '--locked', '--project', 'evals/harness']
        : ['run', '--locked', '--project', 'evals/harness', 'python', ...(action === 'run'
          ? ['evals/harness/gui.py'] : ['evals/harness/manage.py', 'runtime'])];
      const record = { id, action, status: 'running', startedAt: new Date().toISOString(),
        ...(config ? { config, providerId: body.providerId, expectedTrials: (config.smoke ? 10 : 30) * config.attempts * 2 } : {}) };
      await save(record);
      const state = { record, log: '', child: null, stopping: false };
      active = state;
      // Buffer output before redaction so secrets split across chunks cannot escape.
      const secrets = Object.values(headers).filter(v => typeof v === 'string' && v.length > 0)
        .flatMap(value => /^Bearer /i.test(value) ? [value, value.slice(7)] : [value]);
      const redact = value => secrets.reduce((s, secret) => s.split(secret).join('[redacted]'), value)
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
      const runChild = (childArgs, input) => new Promise((resolve, reject) => {
        const child = launch('uv', childArgs, { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
        state.child = child;
        for (const stream of [child.stdout, child.stderr]) {
          let pending = '';
          stream.setEncoding('utf8');
          stream.on('data', chunk => {
            pending += chunk;
            const split = pending.lastIndexOf('\n');
            if (split >= 0) { state.log = (state.log + redact(pending.slice(0, split + 1))).slice(-24000); pending = pending.slice(split + 1); }
            if (pending.length > 24000) pending = ''; // Bound unterminated provider output.
          });
          stream.on('end', () => { state.log = (state.log + redact(pending)).slice(-24000); });
        }
        child.on('error', reject);
        child.on('close', code => resolve(code));
        child.stdin.on('error', () => {});
        child.stdin.end(input ? JSON.stringify(input) + '\n' : undefined);
      });
      void (async () => {
        try {
          let code = await runChild(args, config);
          if (code === 0 && action === 'setup' && !state.stopping) {
            code = await runChild(['run', '--locked', '--project', 'evals/harness', 'python', 'evals/harness/manage.py', 'datasets']);
          }
          record.status = state.stopping ? 'stopped' : code === 0 ? 'completed' : 'failed';
        } catch (error) {
          state.log += redact(`\n${error.message}\n`);
          record.status = state.stopping ? 'stopped' : 'failed';
        } finally {
          state.child = null;
          record.finishedAt = new Date().toISOString();
          record.log = state.log;
          await save(record).catch(() => {});
        }
      })();
      return { id };
    } finally { reserving = false; }
  }
  function stop() {
    if (active?.record.status === 'running') {
      active.stopping = true;
      kill(active.child);
      active.log += '\nStopping the coordinator. Docker task containers may need cleanup in Docker Desktop.\n';
    }
    return { ok: true };
  }
  return { status, check, start, stop };
}
