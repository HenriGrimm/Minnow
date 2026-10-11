import { spawn } from 'node:child_process';

export function cleanEnvironment(extra = {}) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}
const stopping = new WeakMap();
export function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);
  const done = new Promise(resolve => {
    const timer = setTimeout(resolve, 5000); timer.unref?.();
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
  stopping.set(child, done);
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
  return done;
}
export function startProcess(bin, args, options = {}) {
  return spawn(bin, args, {
    cwd: options.cwd, env: options.env ?? cleanEnvironment(),
    windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
}
export function command(bin, args, { cwd, env, signal, timeout = 600000, log, stdout, input } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const child = startProcess(bin, args, { cwd, env });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let output = '', stderr = '', settled = false, stoppingError;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(output);
    };
    const stop = error => {
      stoppingError ??= error;
      void killTree(child).then(() => finish(stoppingError));
    };
    const abort = () => stop(signal?.reason ?? new Error('Cancelled'));
    const timer = timeout > 0 ? setTimeout(() => stop(new Error(`Command timed out: ${bin}`)), timeout) : null;
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', finish);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      const text = String(chunk); output = (output + text).slice(-64000);
      if (stream === child.stderr) stderr = (stderr + text).slice(-8000);
      if (stream === child.stdout && stdout) stdout(text); else log?.(text);
    });
    child.on('close', code => finish(signal?.aborted ? signal.reason : stoppingError ?? (code === 0 ? null
      : new Error(`Command failed (${code}): ${(stdout ? stderr : output).slice(-8000) || 'Process exited without diagnostics'}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}
