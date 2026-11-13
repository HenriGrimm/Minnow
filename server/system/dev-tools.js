/** Host-owned macOS prerequisites. No Homebrew, sudo, or shell-profile edits. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { getMinnowHome } from '../config/home.js';
import { runProcess } from '../process-runner.js';

const NODE_VERSION = '24.22.3';
const GH_VERSION = '2.104.0';
const PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };
const TOOLS = ['github', 'claude', 'codex', 'cursor'];

export function devToolsPath(home = getMinnowHome(), current = process.env.PATH ?? '') {
  const root = path.join(home, 'runtimes', 'dev-tools');
  return [...new Set([...['node', 'github', 'npm'].map(tool => path.join(root, tool, 'bin')),
    ...current.split(path.delimiter).filter(Boolean),
    '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')])].join(path.delimiter);
}

export function activateDevToolsPath() {
  if (process.platform === 'darwin') process.env.PATH = devToolsPath();
}

export function archiveSpec(tool, arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Automatic setup requires an Apple silicon or Intel Mac.');
  if (tool === 'node') {
    const folder = `node-v${NODE_VERSION}-darwin-${arch}`;
    return { folder, file: `${folder}.tar.gz`, base: `https://nodejs.org/dist/v${NODE_VERSION}/`, checksums: 'SHASUMS256.txt' };
  }
  const folder = `gh_${GH_VERSION}_macOS_${arch === 'x64' ? 'amd64' : 'arm64'}`;
  return { folder, file: `${folder}.zip`, base: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/`, checksums: `gh_${GH_VERSION}_checksums.txt` };
}

export function expectedChecksum(text, file) {
  const row = text.split(/\r?\n/).map(line => line.trim().split(/\s+\*?/)).find(parts => parts[1] === file);
  if (!row || !/^[a-f\d]{64}$/i.test(row[0])) throw new Error(`Missing SHA-256 checksum for ${file}.`);
  return row[0].toLowerCase();
}

export function createDevToolsInstaller(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const home = deps.home ?? getMinnowHome;
  const run = deps.run ?? runProcess;
  const request = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const jobs = new Map();
  // Serialize shared runtime installation, including different CLI requests.
  let tail = Promise.resolve();

  async function command(bin, args, cwd, timeout = 15_000) {
    return run(bin, args, { cwd, env: { PATH: devToolsPath(home()), npm_config_prefix: path.join(home(), 'runtimes', 'dev-tools', 'npm') },
      ignoreStdin: true, timeout, signal: AbortSignal.timeout(timeout) });
  }
  async function available(bin, args, cwd) {
    try { return (await command(bin, args, cwd)).code === 0; } catch { return false; }
  }

  async function archive(tool, cwd, job) {
    const spec = archiveSpec(tool, arch);
    job.message = `Downloading ${tool === 'node' ? 'Node.js and npm' : 'GitHub CLI'}…`;
    const checksumResponse = await request(spec.base + spec.checksums, { signal: AbortSignal.timeout(30_000) });
    if (!checksumResponse.ok) throw new Error('Could not download tool checksums. Check your connection and retry.');
    const checksumText = await checksumResponse.text();
    if (checksumText.length > 256 * 1024) throw new Error('Tool checksums exceeded the size limit.');
    const expected = expectedChecksum(checksumText, spec.file);
    const response = await request(spec.base + spec.file, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error('Could not download the tool. Check your connection and retry.');
    const target = path.join(cwd, spec.file);
    const handle = await fs.open(target, 'wx');
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 150 * 1024 * 1024) throw new Error('Tool download exceeded the size limit.');
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
    } finally { await handle.close(); }
    if (hash.digest('hex') !== expected) throw new Error('Tool download failed its SHA-256 check. Retry setup.');
    const extracted = tool === 'node'
      ? await command('/usr/bin/tar', ['-xzf', target, '-C', cwd], cwd)
      : await command('/usr/bin/ditto', ['-x', '-k', target, cwd], cwd);
    if (extracted.code !== 0) throw new Error('Could not unpack the downloaded tool. Retry setup.');
    const folder = path.join(cwd, spec.folder);
    const bin = path.join(folder, 'bin', tool === 'node' ? 'node' : 'gh');
    if (!await available(bin, ['--version'], cwd)) throw new Error('The downloaded tool could not start on this Mac.');
    // Publish only verified trees; retain a broken previous copy until the swap succeeds.
    const destination = path.join(home(), 'runtimes', 'dev-tools', tool);
    const previous = path.join(cwd, 'previous');
    let moved = false;
    try { await fs.rename(destination, previous); moved = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(folder, destination); }
    catch (error) {
      if (moved) await fs.rename(previous, destination);
      throw error;
    }
  }

  async function ensureGit(cwd, job) {
    if (await available('/usr/bin/xcrun', ['--find', 'git'], cwd)) return;
    job.message = 'Approve Apple’s Command Line Tools installer to set up Git. Minnow will continue automatically.';
    await command('/usr/bin/xcode-select', ['--install'], cwd).catch(() => {});
    for (let attempt = 0; attempt < 240; attempt++) {
      await sleep(5000);
      if (await available('/usr/bin/xcrun', ['--find', 'git'], cwd)) return;
    }
    throw new Error('Git setup is not finished. Complete Apple’s installer, then retry here.');
  }

  async function install(tool, job) {
    const root = path.join(home(), 'runtimes', 'dev-tools');
    await fs.mkdir(root, { recursive: true });
    const cwd = await fs.mkdtemp(path.join(root, '.setup-'));
    try {
      if (tool === 'github') {
        if (!await available('gh', ['--version'], cwd)) await archive('github', cwd, job);
      } else {
        // npm installers and the resulting Node shebangs use the same host PATH.
        if (!await available('node', ['-e', 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'], cwd)
          || !await available('npm', ['--version'], cwd)) await archive('node', cwd, job);
        await ensureGit(cwd, job);
        const bin = tool === 'cursor' ? 'cursor-agent' : tool;
        if (!await available(bin, ['--version'], cwd)) {
          job.message = `Installing ${tool === 'cursor' ? 'Cursor Agent' : tool === 'claude' ? 'Claude Code' : 'Codex CLI'}…`;
          let result;
          if (tool === 'cursor') {
            const response = await request('https://cursor.com/install', { signal: AbortSignal.timeout(30_000) });
            if (!response.ok) throw new Error('Could not download the Cursor installer. Retry setup.');
            const script = await response.text();
            if (script.length > 256 * 1024) throw new Error('Cursor installer exceeded the size limit.');
            const file = path.join(cwd, 'cursor-install.sh');
            await fs.writeFile(file, script);
            result = await command('/bin/bash', [file], cwd, 300_000);
          } else {
            result = await command('npm', ['install', '--global', '--prefix', path.join(root, 'npm'), '--no-audit', '--no-fund', PACKAGES[tool]], cwd, 300_000);
          }
          if (result.code !== 0 || !await available(bin, ['--version'], cwd)) {
            throw new Error('CLI installation did not finish. Check your connection and retry setup.');
          }
        }
      }
      await ensureGit(cwd, job);
      activateDevToolsPath();
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  }

  function start(tool) {
    if (platform !== 'darwin') throw new Error('Automatic tool setup is currently available on macOS.');
    if (!TOOLS.includes(tool)) throw new Error('Unknown setup tool.');
    if (jobs.get(tool)?.state === 'running') return { ...jobs.get(tool) };
    const job = { state: 'running', message: 'Preparing tools…', error: null };
    jobs.set(tool, job);
    tail = tail.then(() => install(tool, job)).then(() => {
      Object.assign(job, { state: 'ready', message: 'Tools are ready.' });
    }, error => {
      Object.assign(job, { state: 'error', message: 'Setup needs attention.', error: error.message || 'Could not set up tools. Retry here.' });
    });
    return { ...job };
  }
  return { start, status: tool => ({ ...(jobs.get(tool) ?? { state: 'idle', message: '', error: null }) }) };
}

export const devToolsInstaller = createDevToolsInstaller();
