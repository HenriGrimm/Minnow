import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PACKAGED_AGENT_CHECKS = Object.freeze([
  'asar-esm-runtime', 'native-sqlite', 'canonical-transcript', 'archive',
  'composer-bundle', 'packaged-prompt-capture', 'manual-assets', 'runtime-dispose',
]);
export const PACKAGED_AGENT_RECEIPT = 'MINNOW_PACKAGED_AGENT_CHECK=';
const script = fileURLToPath(import.meta.url);
const worker = fileURLToPath(new URL('./verify-packaged-agent-conversations-worker.mjs', import.meta.url));
const help = 'Usage: node scripts/verify-packaged-agent-conversations.mjs --app-dir <unpacked-app-directory-or-Minnow.app> [--timeout-ms 30000]\n'
  + 'Uses the supplied Electron executable and app.asar with a temporary Minnow home. No inference, installation, signing, publishing, or native rebuild.\n';

function invalid(code) { const error = new Error(code); error.code = code; throw error; }
export function parsePackagedVerificationArgs(args) {
  const options = { timeoutMs: 30_000 };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help' || args[index] === '-h') return { help: true };
    if (!['--app-dir', '--timeout-ms'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) invalid('invalid_arguments');
    const key = args[index++];
    if (key === '--app-dir') { if (options.appDir) invalid('invalid_arguments'); options.appDir = args[index]; }
    else { if (options.timeoutExplicit) invalid('invalid_arguments'); options.timeoutExplicit = true; options.timeoutMs = Number(args[index]); }
  }
  if (!options.appDir || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60_000) invalid('invalid_arguments');
  return { appDir: options.appDir, timeoutMs: options.timeoutMs };
}

async function isFile(file) { return (await fs.stat(file).catch(() => null))?.isFile() === true; }
/** Resolves only known unpacked layouts; this never runs an installer or searches the live installation. */
export async function resolvePackagedApp(appDir, platform = process.platform) {
  if (typeof appDir !== 'string' || !appDir.trim()) invalid('invalid_arguments');
  const root = path.resolve(appDir);
  const bundle = platform === 'darwin' && !root.toLowerCase().endsWith('.app') ? path.join(root, 'Minnow.app') : root;
  const resources = platform === 'darwin' ? path.join(bundle, 'Contents', 'Resources') : path.join(root, 'resources');
  const executables = platform === 'win32' ? [path.join(root, 'Minnow.exe')]
    : platform === 'darwin' ? [path.join(bundle, 'Contents', 'MacOS', 'Minnow')]
      : platform === 'linux' ? [path.join(root, 'minnow'), path.join(root, 'Minnow')] : [];
  if (!executables.length) invalid('unsupported_platform');
  const executable = (await Promise.all(executables.map(async file => await isFile(file) ? file : null))).find(Boolean);
  if (!executable) invalid('app_executable_missing');
  const archive = path.join(resources, 'app.asar');
  if (!await isFile(archive)) invalid('app_asar_missing');
  return { appDir: root, executable, archive };
}

async function removeScratch(directory, temporary) {
  const entry = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!entry) return;
  const actual = await fs.realpath(directory), parent = await fs.realpath(temporary);
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!entry.isDirectory() || entry.isSymbolicLink() || key(path.dirname(actual)) !== key(parent)
    || !path.basename(actual).startsWith('minnow-packaged-agent-check-')) invalid('scratch_cleanup_denied');
  await fs.rm(actual, { recursive: true, force: true });
}

function receipt(stdout, nonce) {
  const matches = String(stdout ?? '').split(/\r?\n/).filter(line => line.startsWith(PACKAGED_AGENT_RECEIPT));
  if (matches.length !== 1) return null;
  try {
    const value = JSON.parse(matches[0].slice(PACKAGED_AGENT_RECEIPT.length));
    if (value.version !== 1 || value.nonce !== nonce || !['PASS', 'FAIL'].includes(value.status) || !Array.isArray(value.checks)
      || value.checks.some(check => !PACKAGED_AGENT_CHECKS.includes(check)) || new Set(value.checks).size !== value.checks.length) return null;
    return value;
  } catch { return null; }
}

/** Test injection replaces process launch only; the CLI always launches the supplied packaged executable. */
export async function verifyPackagedAgentConversations({ appDir, timeoutMs = 30_000 }, { launch = spawnSync } = {}) {
  const startedAt = Date.now();
  const report = { version: 1, status: 'FAIL', inference: false, checks: [] };
  let scratch;
  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) invalid('invalid_arguments');
    const app = await resolvePackagedApp(appDir);
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-packaged-agent-check-'));
    const nonce = randomUUID();
    const result = launch(app.executable, [worker, app.archive, nonce], {
      cwd: scratch, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MINNOW_HOME: scratch,
        MINNOW_TOKEN: '', MINNOW_HEADLESS: '1', BROWSER: 'none', NODE_ENV: 'test' },
      windowsHide: true, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    });
    const parsed = receipt(result.stdout, nonce);
    report.checks = parsed?.checks ?? [];
    if (result.error?.code === 'ETIMEDOUT') report.code = 'runtime_timeout';
    else if (result.error) report.code = 'runtime_launch_failed';
    else if (!parsed) report.code = 'runtime_receipt_missing';
    else if (result.status !== 0 || parsed.status !== 'PASS') {
      report.code = 'runtime_check_failed';
      if (PACKAGED_AGENT_CHECKS.includes(parsed.failedCheck)) report.failedCheck = parsed.failedCheck;
    } else if (PACKAGED_AGENT_CHECKS.some(check => !parsed.checks.includes(check))) report.code = 'runtime_checks_incomplete';
    else { report.status = 'PASS'; report.code = 'packaged_runtime_verified'; }
  } catch (error) {
    report.code = ['invalid_arguments', 'unsupported_platform', 'app_executable_missing', 'app_asar_missing'].includes(error.code) ? error.code : 'verification_failed';
  } finally {
    if (scratch) {
      try { await removeScratch(scratch, os.tmpdir()); }
      catch { report.status = 'FAIL'; report.code = 'scratch_cleanup_failed'; }
    }
  }
  return { ...report, durationMs: Date.now() - startedAt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    const options = parsePackagedVerificationArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(help);
    else {
      const report = await verifyPackagedAgentConversations(options);
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exitCode = report.status === 'PASS' ? 0 : 1;
    }
  } catch {
    process.stdout.write(JSON.stringify({ version: 1, status: 'FAIL', inference: false, code: 'invalid_arguments', checks: [] }) + '\n');
    process.stderr.write(help);
    process.exitCode = 1;
  }
}
