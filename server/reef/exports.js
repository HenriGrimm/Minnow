import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Zip, ZipDeflate } from 'fflate';
import { appRoot, readApp, updateApp, copyTree, safePath, atomicJson, serialize } from './store.js';
import { ensureToolchain, toolchainEnv } from './toolchain.js';
import { command } from './process.js';
import { recordEvent } from './events.js';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
export const EXPORT_EXCLUDES = new Set(['.git', '.github', '.npmrc', 'node_modules', 'data', 'runs', 'logs', 'exports', 'reef-host']);
const activeExports = new Map();
export function stopExports() { for (const controller of activeExports.values()) controller.abort(new Error('Minnow stopped during export')); }
export function appHasExport(id) { return [...activeExports.keys()].some(key => key.startsWith(`${id}:`)); }

/** Stream ZIP output; exported desktop runtimes are too large for an in-memory archive. */
export async function zipDirectory(root, target) {
  const output = createWriteStream(target);
  let failure;
  output.on('error', error => { failure = error; });
  const archive = new Zip((error, bytes, final) => {
    if (error) { failure = error; output.destroy(error); return; }
    output.write(bytes); if (final) output.end();
  });
  async function walk(folder, prefix = '') {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Export contains a symbolic link');
      const file = path.join(folder, entry.name), relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(file, `${relative}/`);
      else if (entry.isFile()) {
        const member = new ZipDeflate(relative, { level: 1 });
        archive.add(member);
        for await (const chunk of createReadStream(file)) {
          if (failure) throw failure;
          member.push(chunk);
          if (output.writableNeedDrain) await once(output, 'drain');
        }
        member.push(new Uint8Array(), true);
      }
    }
  }
  try { await walk(root); const finished = once(output, 'finish'); archive.end(); await finished; if (failure) throw failure; }
  catch (error) { archive.terminate(); output.destroy(); throw error; }
}

export function exportConfig(app, target) {
  return {
    appId: `local.reef.app${app.id.replaceAll('-', '')}`, productName: app.name.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 70) || 'Reef utility',
    directories: { output: 'release' }, files: ['**/*', '!test/**', '!reef.scenarios.json', '!BUILD.md', '!README.md', '!release/**', '!**/.env*', '!**/.npmrc'],
    asar: true, npmRebuild: false, publish: null,
    win: { target: 'portable', signAndEditExecutable: false },
    mac: { target: 'zip', identity: null }, linux: { target: 'dir' },
  };
}
export function githubWorkflow(target, arch = process.arch) {
  const runner = target === 'darwin' ? (arch === 'arm64' ? 'macos-14' : 'macos-15-intel') : target === 'win32' ? 'windows-latest' : 'ubuntu-latest';
  const flag = target === 'win32' ? 'win' : target === 'darwin' ? 'mac' : 'linux';
  return `name: Reef export\non:\n  workflow_dispatch:\njobs:\n  package:\n    runs-on: ${runner}\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '24'\n      - run: npm ci --ignore-scripts\n      - run: npm run build\n      - run: npx --yes --package electron-builder@26.15.3 electron-builder --${flag} --${arch} --publish never\n        env:\n          CSC_IDENTITY_AUTO_DISCOVERY: 'false'\n${target === 'linux' ? '      - run: tar -czf release/reef-linux.tar.gz -C release linux*-unpacked\n' : ''}      - uses: actions/upload-artifact@v4\n        with:\n          name: reef-${target}-${arch}\n          path: release/${target === 'linux' ? '*.tar.gz' : target === 'win32' ? '*.exe' : '*.zip'}\n          retention-days: 7\n`;
}
async function prepareExport(app, root, target, tools, options) {
  const release = await safePath(appRoot(app.id), 'releases', app.release.id);
  await copyTree(release, root, { exclude: EXPORT_EXCLUDES });
  const wrapper = path.join(root, 'reef-host');
  await fs.mkdir(wrapper, { recursive: true });
  await fs.copyFile(path.join(sourceDirectory, 'runtime-host.mjs'), path.join(wrapper, 'runtime-host.mjs'));
  await fs.copyFile(path.join(sourceDirectory, 'electron-wrapper.cjs'), path.join(wrapper, 'electron.cjs'));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  pkg.main = 'reef-host/electron.cjs'; pkg.build = exportConfig(app, target);
  pkg.devDependencies = { ...pkg.devDependencies, electron: '43.2.0' };
  pkg.scripts = { build: 'tsc --noEmit && vite build --base=./', package: `npx --yes --package electron-builder@26.15.3 electron-builder --publish never` };
  await atomicJson(path.join(root, 'package.json'), pkg);
  await command(tools.node, [tools.npm, 'install', '--package-lock-only', '--ignore-scripts'], { ...options, cwd: root, env: toolchainEnv(tools) });
  await fs.writeFile(path.join(root, 'BUILD.md'), '# Build this app\n\nInstall Node 24. Run `npm ci --ignore-scripts`, `npm run build`, then `npm run package`.\nPackages are unsigned and unnotarized. The app works independently of Minnow.\n');
}
export async function exportCapabilities() {
  let docker = false, github = false;
  try { await command('docker', ['info', '--format', '{{.OSType}}'], { timeout: 5000 }); docker = true; } catch {}
  try { await command('gh', ['auth', 'status'], { timeout: 5000 }); github = true; } catch {}
  return { platform: process.platform, arch: process.arch, docker, github };
}
export async function runGithubExport(app, root, item, options) {
  const execute = options.command ?? command;
  const workflowDir = path.join(root, '.github', 'workflows');
  await fs.mkdir(workflowDir, { recursive: true });
  await fs.writeFile(path.join(workflowDir, 'reef.yml'), githubWorkflow(item.target, item.arch));
  const gh = args => execute('gh', args, { ...options, cwd: root });
  let repo = app.githubRepo;
  if (!repo) {
    const login = (await gh(['api', 'user', '--jq', '.login'])).trim();
    if (!/^[a-zA-Z0-9-]+$/.test(login)) throw new Error('Could not identify the GitHub account');
    repo = `${login}/reef-${app.id}`;
    await gh(['repo', 'create', repo, '--private']);
    // Persist immediately so a retry never creates a second repository.
    await updateApp(app.id, current => { current.githubRepo = repo; });
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid export repository');
  const privacy = JSON.parse(await gh(['repo', 'view', repo, '--json', 'isPrivate']));
  if (privacy.isPrivate !== true) throw new Error('Cloud export requires a private repository');
  const git = args => execute('git', ['-c', 'user.name=Minnow Reef', '-c', 'user.email=reef@localhost', ...args], { ...options, cwd: root });
  await git(['init', '-b', 'main']);
  await git(['add', '-f', '.']);
  await git(['commit', '-m', `Export ${item.id}`]);
  await git(['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
  // Only this private export staging repo is pushed; app source history stays local.
  if (app.githubRepo && (await git(['-c', 'credential.helper=!gh auth git-credential', 'ls-remote', '--heads', 'origin', 'main'])).trim()) {
    await git(['-c', 'credential.helper=!gh auth git-credential', 'fetch', 'origin', 'main']);
    const tree = (await git(['rev-parse', 'HEAD^{tree}'])).trim();
    const parent = (await git(['rev-parse', 'origin/main'])).trim();
    const commit = (await git(['commit-tree', tree, '-p', parent, '-m', `Export ${item.id}`])).trim();
    await git(['update-ref', 'refs/heads/main', commit]);
  }
  await git(['-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', 'main']);
  const sha = (await git(['rev-parse', 'HEAD'])).trim();
  await gh(['workflow', 'run', 'reef.yml', '--repo', repo, '--ref', 'main']);
  let run;
  for (let attempt = 0; attempt < 60; attempt++) {
    options.signal.throwIfAborted();
    const rows = JSON.parse(await gh(['run', 'list', '--repo', repo, '--workflow', 'reef.yml', '--commit', sha, '--json', 'databaseId,url,status,conclusion']));
    run = rows[0]; if (run) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!run) throw new Error('GitHub did not start the export workflow');
  await updateApp(app.id, current => { current.exports.find(x => x.id === item.id).url = run.url; });
  await gh(['run', 'watch', String(run.databaseId), '--repo', repo, '--exit-status']);
  const destination = path.join(root, 'release');
  await gh(['run', 'download', String(run.databaseId), '--repo', repo, '--dir', destination]);
  return destination;
}

export async function queueExport(id, input) {
  return serialize('reef-admission', () => admitExport(id, input));
}
async function admitExport(id, input) {
  const app = await readApp(id);
  if (!app.release) throw new Error('Build a verified app before exporting');
  if (!['source', 'local', 'docker', 'github'].includes(input.method) || !['win32', 'darwin', 'linux'].includes(input.target)) throw new Error('Invalid export method or target');
  if (input.method === 'github' && input.cloudConsent !== true) throw new Error('Confirm uploading source to a private GitHub repository for this export');
  if (input.method === 'local' && input.target !== process.platform) throw new Error('Use a build kit, Docker, or GitHub Actions for another OS');
  if (input.method === 'docker' && input.target === 'darwin') throw new Error('macOS export requires macOS or GitHub Actions');
  if (appHasExport(id)) throw Object.assign(new Error('An export is already running for this app'), { statusCode: 409 });
  const item = { id: randomUUID(), releaseId: app.release.id, method: input.method, target: input.target,
    arch: input.arch === 'arm64' ? 'arm64' : input.arch === 'x64' ? 'x64' : process.arch, status: 'queued', log: '' };
  const controller = new AbortController();
  activeExports.set(`${id}:${item.id}`, controller);
  try { await updateApp(id, current => { current.exports.push(item); }); }
  catch (error) { activeExports.delete(`${id}:${item.id}`); throw error; }
  void executeExport(app, item, controller).catch(error => console.error('[reef] export persistence failed', error)).finally(() => activeExports.delete(`${id}:${item.id}`));
  return item;
}
async function executeExport(app, item, controller) {
  const timer = setTimeout(() => controller.abort(new Error('Export exceeded the 45-minute deadline')), 45 * 60000);
  let tail = '';
  const options = { signal: controller.signal, log: text => { tail = (tail + text).slice(-16000); } };
  try {
    await updateApp(app.id, current => { current.exports.find(x => x.id === item.id).status = 'building'; });
    const tools = await ensureToolchain(options);
    const folder = await safePath(appRoot(app.id), 'exports', item.id);
    const root = path.join(folder, 'source');
    await prepareExport(app, root, item.target, tools, options);
    let output = root;
    if (item.method === 'github') output = await runGithubExport(app, root, item, options);
    else if (item.method === 'docker') {
      const target = item.target === 'win32' ? 'win' : 'linux';
      const cidfile = path.join(folder, 'container-id');
      try {
        await command('docker', ['run', '--rm', '--cidfile', cidfile, '-v', `${root}:/project`, '-w', '/project', 'electronuserland/builder:wine', '/bin/bash', '-c', `npm ci --ignore-scripts && npx --yes --package electron-builder@26.15.3 electron-builder --${target} --${item.arch} --publish never`], options);
      } finally {
        // Killing the CLI does not stop a daemon-owned container.
        const cid = await fs.readFile(cidfile, 'utf8').catch(() => '');
        if (/^[a-f0-9]{64}$/.test(cid.trim())) await command('docker', ['rm', '-f', cid.trim()], { timeout: 10000 }).catch(() => {});
      }
      output = path.join(root, 'release');
    } else if (item.method === 'local') {
      const env = toolchainEnv(tools, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
      await command(tools.node, [tools.npm, 'ci', '--ignore-scripts'], { ...options, cwd: root, env });
      const target = item.target === 'win32' ? 'win' : item.target === 'darwin' ? 'mac' : 'linux';
      await command(tools.node, [tools.npm, 'exec', '--yes', '--package=electron-builder@26.15.3', '--', 'electron-builder', `--${target}`, `--${item.arch}`, '--publish', 'never'], { ...options, cwd: root, env });
      output = path.join(root, 'release');
    }
    let filename = `reef-${app.id}-${item.method === 'source' ? 'source' : item.target}.zip`;
    if (item.method === 'source') await zipDirectory(output, path.join(folder, filename));
    else if (item.target === 'linux' && item.method !== 'github') {
      // tar preserves executable bits and Electron's runtime symlinks.
      filename = `reef-${app.id}-linux.tar.gz`;
      const unpacked = (await fs.readdir(output)).find(name => /^linux.*-unpacked$/.test(name));
      if (!unpacked) throw new Error('Linux package output was not found');
      await command('tar', ['-czf', path.join(folder, filename), '-C', output, unpacked], options);
    } else {
      const extension = item.target === 'win32' ? '.exe' : item.target === 'linux' ? '.tar.gz' : '.zip';
      async function findArtifact(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(extension)) return path.join(directory, entry.name);
          if (entry.isDirectory() && item.method === 'github') { const found = await findArtifact(path.join(directory, entry.name)); if (found) return found; }
        }
      }
      const artifact = await findArtifact(output);
      if (!artifact) throw new Error('Desktop package artifact was not found');
      filename = `reef-${app.id}-${item.target}${extension}`;
      await fs.copyFile(artifact, path.join(folder, filename));
    }
    await updateApp(app.id, current => Object.assign(current.exports.find(x => x.id === item.id), { status: 'ready', filename, log: tail }));
  } catch (error) {
    await updateApp(app.id, current => Object.assign(current.exports.find(x => x.id === item.id), { status: 'failed', error: String(error.message), log: tail }));
  } finally {
    clearTimeout(timer);
    await recordEvent(app.id, { type: 'export', exportId: item.id });
  }
}
