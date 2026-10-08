import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { reefRoot, safePath, serialize } from './store.js';
import { command, cleanEnvironment } from './process.js';

export const NODE_VERSION = '24.21.0';
const versionRoot = () => path.join(reefRoot(), 'cache', `node-v${NODE_VERSION}-${process.platform}-${process.arch}`);
export function toolchainPaths(root = versionRoot()) {
  const win = process.platform === 'win32';
  return { root, node: path.join(root, win ? 'node.exe' : 'bin/node'), npm: path.join(root, win ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js') };
}
async function download(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Toolchain download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
export async function ensureToolchain({ signal, log } = {}) {
  return serialize('toolchain', async () => {
    const paths = toolchainPaths();
    try { await fs.access(paths.node); await fs.access(paths.npm); return paths; } catch {}
    if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('Reef requires Windows, macOS or Linux on x64 or arm64');
    const os = process.platform === 'win32' ? 'win' : process.platform;
    const basename = `node-v${NODE_VERSION}-${os}-${process.arch}`;
    const filename = `${basename}.${os === 'win' ? 'zip' : 'tar.gz'}`;
    const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
    log?.(`Downloading Node ${NODE_VERSION} and npm…\n`);
    const sums = (await download(`${base}/SHASUMS256.txt`, signal)).toString('utf8');
    const checksum = sums.split('\n').find(line => line.trim().endsWith(` ${filename}`))?.split(/\s+/)[0];
    if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('No official checksum for this Node archive');
    const archive = await download(`${base}/${filename}`, signal);
    if (createHash('sha256').update(archive).digest('hex') !== checksum) throw new Error('Node archive checksum mismatch');
    const staging = await safePath(reefRoot(), 'cache', `download-${randomUUID()}`);
    await fs.mkdir(staging, { recursive: true });
    const archivePath = path.join(staging, filename);
    try {
      await fs.writeFile(archivePath, archive);
      if (os === 'win') {
        // Arguments travel through environment variables, never interpolated into PowerShell source.
        await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:REEF_ARCHIVE -DestinationPath $env:REEF_DEST'], {
          signal, env: cleanEnvironment({ REEF_ARCHIVE: archivePath, REEF_DEST: staging }),
        });
      } else await command('tar', ['-xzf', archivePath, '-C', staging], { signal });
      await safePath(staging, basename);
      await fs.rename(path.join(staging, basename), paths.root);
    } finally { await fs.rm(await safePath(reefRoot(), path.relative(reefRoot(), staging)), { recursive: true, force: true }); }
    return paths;
  });
}
export function toolchainEnv(tools, extra = {}) {
  const env = cleanEnvironment(extra);
  const key = process.platform === 'win32' ? 'Path' : 'PATH';
  const prior = env.Path ?? env.PATH ?? '';
  delete env.Path; delete env.PATH;
  return { ...env, [key]: `${path.dirname(tools.node)}${path.delimiter}${prior}`, npm_config_cache: path.join(reefRoot(), 'cache', 'npm'), npm_config_audit: 'false', npm_config_fund: 'false' };
}
