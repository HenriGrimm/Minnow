import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { getMinnowHome } from '../config/home.js';
import { runProcess } from '../process-runner.js';
import { killProcessTreeAndWait } from '../terminal-runner.js';
import { resolveOneShotSpawn } from '../terminal/one-shot-spawn.js';
import { resolveExecuteShellProfile } from '../terminal/shell-config.js';
import { applyAgentShellSandbox } from '../terminal/sandbox/index.js';
import { resolveShellSandboxForRun } from '../terminal/sandbox/resolve-for-run.js';
import { getShellProfileById } from '../terminal/shell-profiles.js';
import { actionRoot, inside, writeJson } from './action-common.js';
import { commandList, readActionSecrets } from './action-config.js';
import { workflowView, validateInputs } from './workflow-ops.js';
import { acquireActionWorktree, releaseActionWorktree } from './action-run-lock.js';

const active = new Map();
const LIMIT = 4 * 1024 * 1024;
const RETENTION = 7 * 86400000;
const runDir = () => path.join(getMinnowHome(), 'runs', 'actions');
function runFile(id) {
  if (!/^local-[a-f0-9-]{36}$/.test(id || '')) throw new Error('Invalid local run ID');
  return path.join(runDir(), `${id}.json`);
}
export function cleanActionEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(path|pathext|systemroot|windir|comspec|home|userprofile|appdata|localappdata|temp|tmp|tmpdir|shell|lang|lc_.*|term|programfiles|programfiles\(x86\)|programw6432|docker_host|docker_context|docker_config)$/i.test(
        key,
      )
    )
      env[key] = value;
  }
  return { ...env, ...extra, NO_COLOR: '1', CI: 'true' };
}

// Keep a suffix until the next chunk so secrets spanning chunks are masked too.
export function createRedactor(secrets, emit) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const keep = Math.max(1, ...values.map((s) => s.length)) - 1;
  let pending = '';
  return (chunk, final = false) => {
    pending += chunk;
    let stop = final ? pending.length : Math.max(0, pending.length - keep);
    if (stop < pending.length && /[\uD800-\uDBFF]/.test(pending[stop - 1] || '')) stop--;
    let output = '';
    let pos = 0;
    while (pos < stop) {
      const secret = values.find((value) => pending.startsWith(value, pos));
      if (secret) {
        output += '[REDACTED]';
        pos += secret.length;
      } else {
        output += pending[pos];
        pos++;
      }
    }
    pending = pending.slice(pos);
    if (output) emit(output);
  };
}

export async function localCapabilities() {
  const probe = async (command, args) => {
    try {
      const result = await runProcess(command, args, { timeout: 15000 });
      return {
        available: result.code === 0,
        detail: (result.stdout || result.stderr).trim().slice(0, 1000),
      };
    } catch (error) {
      return { available: false, detail: error.message };
    }
  };
  const [act, docker] = await Promise.all([
    probe('act', ['--version']),
    probe('docker', ['info', '--format', '{{.ServerVersion}}']),
  ]);
  return { ok: true, act, docker, platform: process.platform };
}

async function cleanupContainers(id, cwd) {
  const controller = new AbortController();
  const result = await runProcess(
    'docker',
    ['ps', '-aq', '--filter', `label=minnow.action=${id}`],
    { cwd, signal: controller.signal, timeout: 15000 },
  );
  const ids = result.stdout.split(/\s+/).filter((v) => /^[a-f0-9]{12,64}$/.test(v));
  if (ids.length)
    await runProcess('docker', ['rm', '-f', ...ids], {
      cwd,
      signal: controller.signal,
      timeout: 30000,
    });
}

export async function localRunStart(args) {
  const root = await actionRoot(args.cwd);
  const id = `local-${randomUUID()}`;
  acquireActionWorktree(root, id);
  let scratch;
  try {
    const allSecrets = await readActionSecrets(root);
    let target;
    let label;
    let definition;
    let extra = {};
    let values = [];
    let working = root;
    if (args.kind === 'workflow') {
      const caps = await localCapabilities();
      if (!caps.act.available || !caps.docker.available)
        throw new Error('Local workflows require act and a running Docker engine');
      const { workflow } = await workflowView({ ...args, cwd: root, location: 'local' });
      if (workflow.error) throw new Error(workflow.error);
      const event = args.event || 'workflow_dispatch';
      if (!workflow.events.includes(event))
        throw new Error('Choose an event declared by this workflow');
      const selected = args.job ? workflow.jobs.filter((j) => j.id === args.job) : workflow.jobs;
      if (!selected.length) throw new Error('No matching jobs');
      const visit = (job) => {
        if (!job.supported)
          throw new Error(`Job ${job.id} does not declare a supported Linux runner`);
        for (const dep of job.needs) {
          const found = workflow.jobs.find((j) => j.id === dep);
          if (!found) throw new Error('Unknown job dependency');
          if (!seen.has(dep)) {
            seen.add(dep);
            visit(found);
          }
        }
      };
      const seen = new Set();
      selected.forEach(visit);
      const inputs = validateInputs(workflow.inputs, args.inputs);
      const image = args.image || 'catthehacker/ubuntu:act-latest';
      if (!/^[a-zA-Z0-9][a-zA-Z0-9/.:@_-]+$/.test(image))
        throw new Error('Invalid container image');
      scratch = path.join(runDir(), `${id}-private`);
      await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
      const secrets = {};
      for (const name of args.secretNames || []) {
        if (!Object.hasOwn(allSecrets, name)) throw new Error(`Missing secret ${name}`);
        secrets[name] = allSecrets[name];
      }
      // Values enter the child environment, never argv. act -s NAME reads that value.
      extra = secrets;
      values = Object.values(secrets);
      await fs.writeFile(path.join(scratch, 'empty'), '', { mode: 0o600 });
      await writeJson(path.join(scratch, 'event.json'), { inputs });
      const argv = [
        event,
        '--directory',
        root,
        '--workflows',
        args.path,
        '--eventpath',
        path.join(scratch, 'event.json'),
        '--env-file',
        path.join(scratch, 'empty'),
        '--secret-file',
        path.join(scratch, 'empty'),
        '--var-file',
        path.join(scratch, 'empty'),
        '--container-options',
        `--label=minnow.action=${id}`,
        '--container-daemon-socket',
        '-',
        '--action-offline-mode=false',
      ];
      for (const runner of new Set(workflow.jobs.filter((j) => j.supported).map((j) => j.runner)))
        argv.push('-P', `${runner}=${image}`);
      if (args.job) argv.push('--job', args.job);
      for (const name of Object.keys(secrets)) argv.push('--secret', name);
      target = { command: 'act', args: argv, shell: false };
      working = scratch;
      label = workflow.name;
      definition = {
        kind: 'workflow',
        path: args.path,
        event,
        job: args.job,
        inputs,
        image,
        secretNames: Object.keys(secrets),
      };
    } else if (args.kind === 'command') {
      const { commands } = await commandList({ cwd: root });
      const command = commands.find((c) => c.id === args.commandId);
      if (!command) throw new Error('Command no longer exists');
      working = await inside(root, command.cwd);
      extra = { ...command.env };
      for (const [name, ref] of Object.entries(command.secrets)) {
        if (!Object.hasOwn(allSecrets, ref)) throw new Error(`Missing secret ${ref}`);
        extra[name] = allSecrets[ref];
        values.push(allSecrets[ref]);
      }
      const profile = command.shellProfile
        ? getShellProfileById(command.shellProfile)
        : await resolveExecuteShellProfile(root);
      if (command.shellProfile && !profile)
        throw new Error('Shell profile is unavailable on this machine');
      if (command.scriptName) {
        if (!/^[\w:./-]+$/.test(command.scriptName) || command.scriptName.startsWith('-'))
          throw new Error('Unsupported script name');
        target =
          process.platform === 'win32'
            ? resolveOneShotSpawn({
                command: `${command.manager} run ${command.scriptName}`,
                cwd: working,
              })
            : { command: command.manager, args: ['run', command.scriptName], shell: false };
      } else if (profile?.id === 'powershell' || profile?.id === 'pwsh') {
        target = {
          command: profile.shell,
          args: ['-NoProfile', '-NonInteractive', '-Command', command.command],
          shell: false,
        };
      } else
        target = resolveOneShotSpawn({
          command: command.command,
          shellProfile: profile,
          cwd: working,
        });
      label = command.label;
      definition = { kind: 'command', commandId: command.id };
    } else throw new Error('Choose workflow or command');
    const git = async (flags) => (await runProcess('git', flags, { cwd: root })).stdout.trim();
    const record = {
      id,
      kind: args.kind,
      label,
      cwd: root,
      branch: await git(['branch', '--show-current']),
      sha: await git(['rev-parse', 'HEAD']),
      dirty: Boolean(await git(['status', '--porcelain'])),
      status: 'running',
      startedAt: new Date().toISOString(),
      source: args.source === 'agent' ? 'agent' : 'user',
      chatId: args.chatId,
      definition,
      hostPid: process.pid,
      logBytes: 0,
    };
    await fs.mkdir(runDir(), { recursive: true });
    if (args.source === 'agent') {
      const policy = await resolveShellSandboxForRun({ chatId: args.chatId });
      if (args.kind === 'workflow' && policy.mode !== 'off' && !policy.allowUnsandboxed)
        throw new Error(
          'Docker workflow execution requires host access. Allow unsandboxed shell execution in the existing tool settings to run this action.',
        );
      target = applyAgentShellSandbox(target, {
        source: 'agent',
        mode: policy.mode,
        allowUnsandboxed: policy.allowUnsandboxed,
        cwd: working,
        workspaceRoot: root,
        worktreeRoot: root,
      });
      if (target.sandbox?.blocked || target.sandbox?.needsEscalation)
        throw new Error(target.sandbox.detail || 'Shell sandbox policy blocked this action');
    }
    await writeJson(runFile(id), record);
    const env = cleanActionEnv({ ...target.env, ...extra });
    const child = fork(new URL('./action-worker.js', import.meta.url), [], {
      cwd: working,
      env: { ...env, MINNOW_HOME: getMinnowHome(), ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    record.pid = child.pid;
    const entry = {
      child,
      record,
      scratch,
      queue: writeJson(runFile(id), record).catch(() => {}),
      stopping: false,
    };
    active.set(id, entry);
    const emit = (text) => {
      const bytes = Buffer.from(text);
      const remaining = LIMIT - record.logBytes;
      if (bytes.length > remaining) record.truncated = true;
      const capped = bytes.subarray(0, Math.max(0, remaining));
      record.logBytes += capped.length;
      if (capped.length)
        entry.queue = entry.queue
          .then(() => fs.appendFile(path.join(runDir(), `${id}.log`), capped))
          .catch(() => {
            record.logError = 'Could not persist all log output';
          });
    };
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const redact = [createRedactor(values, emit), createRedactor(values, emit)];
    child.stdout.on('data', (chunk) => redact[0](decoders[0].write(chunk)));
    child.stderr.on('data', (chunk) => redact[1](decoders[1].write(chunk)));
    child.on('error', (error) => {
      record.error = error.message;
    });
    entry.finished = new Promise((resolve) =>
      child.on('close', async (code) => {
        try {
          redact.forEach((fn, i) => fn(decoders[i].end(), true));
          await entry.queue;
          if (args.kind === 'workflow')
            await cleanupContainers(id, root).catch((error) => {
              record.cleanupError = error.message;
            });
          record.status = entry.stopping
            ? 'cancelled'
            : code === 0 && !record.error
              ? 'success'
              : 'failure';
          record.exitCode = code;
          record.finishedAt = new Date().toISOString();
          await writeJson(runFile(id), record).catch((error) => {
            record.error = `Could not save final run status: ${error.message}`;
          });
        } finally {
          active.delete(id);
          releaseActionWorktree(root, id);
          if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
          resolve();
        }
      }),
    );
    child.send({ target, cwd: working, env, id, kind: args.kind }, (error) => {
      if (error) {
        record.error = error.message;
        void killProcessTreeAndWait(child);
      }
    });
    return { ok: true, run: record };
  } catch (error) {
    releaseActionWorktree(root, id);
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

export async function localRunList(args = {}) {
  const root = await actionRoot(args.cwd);
  const runs = [];
  for (const name of await fs.readdir(runDir()).catch(() => [])) {
    if (!/^local-[a-f0-9-]{36}\.json$/.test(name)) continue;
    const record = await fs
      .readFile(path.join(runDir(), name), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    if (!record || record.cwd !== root) continue;
    if (record.status === 'running' && !active.has(record.id)) {
      record.status = 'interrupted';
      record.finishedAt = new Date().toISOString();
      await writeJson(runFile(record.id), record);
    }
    if (record.finishedAt && Date.now() - Date.parse(record.finishedAt) > RETENTION) {
      await fs.rm(runFile(record.id), { force: true });
      await fs.rm(path.join(runDir(), `${record.id}.log`), { force: true });
      continue;
    }
    runs.push(active.get(record.id)?.record || record);
  }
  return { ok: true, runs: runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)) };
}
export async function localRunView(args) {
  const root = await actionRoot(args.cwd);
  const record =
    active.get(args.id)?.record || JSON.parse(await fs.readFile(runFile(args.id), 'utf8'));
  if (record.cwd !== root) throw new Error('Run belongs to another worktree');
  if (record.status === 'running' && !active.has(record.id)) {
    record.status = 'interrupted';
    record.finishedAt = new Date().toISOString();
    await writeJson(runFile(record.id), record);
  }
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const file = await fs.open(path.join(runDir(), `${record.id}.log`), 'r').catch(() => null);
  const buffer = Buffer.alloc(64 * 1024);
  let bytesRead = 0;
  try {
    if (file) {
      ({ bytesRead } = await file.read(buffer, 0, buffer.length, offset));
      if (bytesRead === buffer.length) {
        let lead = bytesRead - 1;
        while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead--;
        const first = buffer[lead];
        const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
        if (lead + width > bytesRead) bytesRead = lead;
      }
    }
  } finally {
    await file?.close();
  }
  return {
    ok: true,
    run: record,
    log: buffer.subarray(0, bytesRead).toString('utf8'),
    nextOffset: offset + bytesRead,
  };
}
export async function localRunCancel(args) {
  const { run } = await localRunView(args);
  const entry = active.get(run.id);
  if (!entry) return { ok: true, run };
  entry.stopping = true;
  await killProcessTreeAndWait(entry.child);
  await entry.finished;
  return { ok: true, run: entry.record };
}
export async function localRunRerun(args) {
  const { run } = await localRunView(args);
  return localRunStart({
    ...run.definition,
    cwd: run.cwd,
    source: args.source,
    chatId: args.chatId,
  });
}

export async function shutdownLocalActions() {
  await Promise.all(
    [...active.values()].map(async (entry) => {
      entry.stopping = true;
      await killProcessTreeAndWait(entry.child);
      await entry.finished;
    }),
  );
}
