// Own the process tree even when the HTTP server exits unexpectedly. No secrets
// are serialized to disk: the launch descriptor arrives over a private IPC pipe.
import { spawn } from 'node:child_process';
import { killProcessTreeAndWait } from '../terminal-runner.js';
import { runProcess } from '../process-runner.js';

let child;
let descriptor;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (child) await killProcessTreeAndWait(child).catch(() => {});
  if (descriptor?.kind === 'workflow') {
    try {
      const result = await runProcess(
        'docker',
        ['ps', '-aq', '--filter', `label=minnow.action=${descriptor.id}`],
        { timeout: 15000 },
      );
      const ids = result.stdout.split(/\s+/).filter((id) => /^[a-f0-9]{12,64}$/.test(id));
      if (ids.length) await runProcess('docker', ['rm', '-f', ...ids], { timeout: 30000 });
    } catch {
      /* The next inspection reports an interrupted run. */
    }
  }
  process.exit(1);
}
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.once('message', (message) => {
  descriptor = message;
  const target = message.target;
  child = spawn(target.command, target.args, {
    cwd: target.cwd || message.cwd,
    shell: target.shell,
    env: message.env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once('error', (error) => {
    process.stderr.write(error.message);
  });
  child.once('close', (code) => {
    if (stopping) return;
    // Let stdout/stderr drain before exiting so large final log chunks survive.
    process.removeAllListeners('disconnect');
    process.exitCode = code ?? 1;
    if (process.connected) process.disconnect();
  });
});
