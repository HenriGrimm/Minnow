import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureToolchain, toolchainEnv } from './toolchain.js';
import { command } from './process.js';
import { appRoot, reefRoot, safePath, copyTree, serialize } from './store.js';
import { runAgent } from './agent.js';
import { startRuntime } from './runtime.js';
import { hostScript } from './host-scripts.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const excluded = new Set(['.git', 'node_modules', 'dist', 'reef-host', 'release']);
const git = (cwd, args, options) => command('git', ['-c', 'user.name=Minnow Reef', '-c', 'user.email=reef@localhost', '-c', 'core.hooksPath=/dev/null', ...args], { ...options, cwd });
const contract = `You are building a finished local utility in Reef. Do not ask questions. Make sensible defaults. Use only source file tools; the host handles Git, npm, builds and tests. Read README.md. Use Vite/TypeScript, backend.mjs for optional Node APIs, relative api/ URLs, pure JS/WASM dependencies. Do not add native modules, executables, external services or credentials. Do not edit reef-host, .git, or node_modules. Add meaningful node:test tests under test/*.test.mjs and at least one reef.scenarios.json browser scenario with interaction and expected visible result. Never replace tests with unconditional success. The app must implement the prompt, with accessible polished UI and useful errors. Do not merely provide instructions.`;

async function ensureBrowserTools(tools, options) {
  return serialize('browser-tools', async () => {
    const root = await safePath(reefRoot(), 'cache', 'browser');
    const entry = path.join(root, 'node_modules', 'playwright', 'index.mjs');
    const env = toolchainEnv(tools, { PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'browsers') });
    try { await fs.access(entry); } catch {
      await fs.mkdir(root, { recursive: true });
      await command(tools.node, [tools.npm, 'install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', 'playwright@1.64.0'], { ...options, env });
    }
    await command(tools.node, [path.join(root, 'node_modules/playwright/cli.js'), 'install', 'chromium'], { ...options, env });
    return { entry, env };
  });
}

export async function checkProject(workspace) {
  await safePath(workspace);
  const pkg = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
  if (pkg.type !== 'module') throw new Error('Template must remain an ES module project');
  if (pkg.workspaces) throw new Error('Reef does not support dependency workspaces');
  if (pkg.devDependencies?.vite !== '8.1.5' || pkg.devDependencies?.typescript !== '5.9.3') throw new Error('Keep the template Vite and TypeScript versions unchanged');
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || !/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(version)) throw new Error(`Pin ${name} to an exact registry version; local, Git and range dependencies are unsupported`);
  }
  const tests = (await fs.readdir(path.join(workspace, 'test'))).filter(name => name.endsWith('.test.mjs'));
  if (!tests.length) throw new Error('The app must include functional node:test tests');
  return tests;
}

export async function checkRuntimeDependencies(workspace) {
  const lock = JSON.parse(await fs.readFile(path.join(workspace, 'package-lock.json'), 'utf8'));
  async function inspect(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.bin') continue;
      if (entry.isSymbolicLink()) throw new Error('Runtime dependencies may not contain symbolic links');
      if (entry.isDirectory()) await inspect(path.join(folder, entry.name));
      else if (/\.(node|exe|dll|so|dylib)$/i.test(entry.name)) throw new Error(`Native runtime dependency is unsupported: ${entry.name}. Use JavaScript or WASM.`);
    }
  }
  for (const [relative, pkg] of Object.entries(lock.packages ?? {})) {
    if (!relative || pkg.dev) continue;
    if (!relative.startsWith('node_modules/') || pkg.link) throw new Error('Runtime dependencies must come from the registry');
    const folder = path.resolve(workspace, relative);
    if (path.relative(workspace, folder).startsWith('..')) throw new Error('Invalid dependency path');
    try { await inspect(folder); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function buildApp({ app, run, baseUrl, signal, stage, log, agent = runAgent }) {
  const options = { signal, log };
  const tools = await ensureToolchain(options);
  const env = toolchainEnv(tools);
  const repo = await safePath(appRoot(app.id), 'repo');
  await stage('scaffolding', 3);
  await command('git', ['--version'], options);
  try { await fs.access(path.join(repo, '.git')); }
  catch {
    await copyTree(path.join(directory, 'template'), repo);
    await git(repo, ['init', '-b', 'main'], options);
    await git(repo, ['add', '.'], options);
    await git(repo, ['commit', '-m', 'Initialize Reef utility'], options);
  }
  if ((await git(repo, ['status', '--porcelain'], options)).trim()) throw new Error('The app repository has uncommitted changes. Commit them in Code before building a revision.');
  const workspace = await safePath(appRoot(app.id), 'worktrees', run.id);
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  await git(repo, ['worktree', 'add', '--detach', workspace, 'HEAD'], options);
  const runFolder = await safePath(appRoot(app.id), 'runs', run.id);
  await fs.mkdir(runFolder, { recursive: true });
  await stage('planning', 10);
  const plan = await agent({ app, runId: run.id, workspace, baseUrl, signal, log, phase: 'plan', prompt: `${contract}\nPlan the implementation and meaningful acceptance tests. Return the plan in your response.\nRequest: ${run.prompt}` });
  await fs.writeFile(path.join(runFolder, 'plan.txt'), plan.text);
  let diagnostics = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    await stage(attempt ? 'repairing' : 'building', 20, attempt);
    await agent({ app, runId: run.id, workspace, baseUrl, signal, log, phase: 'build', prompt: `${contract}\nRequest: ${run.prompt}\nPlan: ${plan.text}\n${diagnostics ? `Repair these verification failures:\n${diagnostics}` : 'Implement now.'}` });
    try {
      const tests = await checkProject(workspace);
      await stage('installing', 60, attempt);
      await command(tools.node, [tools.npm, 'install', '--package-lock-only', '--ignore-scripts'], { ...options, cwd: workspace, env });
      await command(tools.node, [tools.npm, 'ci', '--ignore-scripts'], { ...options, cwd: workspace, env });
      await checkRuntimeDependencies(workspace);
      await stage('checking', 70, attempt);
      await command(tools.node, ['node_modules/typescript/bin/tsc', '--noEmit'], { ...options, cwd: workspace, env });
      const testOutput = await command(tools.node, ['--test', ...tests.map(name => `test/${name}`)], { ...options, cwd: workspace, env });
      if (!/(?:# tests |ℹ tests )([1-9]\d*)/.test(testOutput)) throw new Error('No functional tests ran');
      await command(tools.node, ['node_modules/vite/bin/vite.js', 'build', '--base=./'], { ...options, cwd: workspace, env });
      const browser = await ensureBrowserTools(tools, options);
      const runtime = await startRuntime(workspace, path.join(runFolder, 'test-data'), tools, signal);
      try {
        await command(tools.node, [await hostScript('verify-browser.mjs'), browser.entry, runtime.url, path.join(workspace, 'reef.scenarios.json'), path.join(runFolder, 'preview.png')], { ...options, env: browser.env, timeout: 180000 });
      } finally { await runtime.stop(); }
      await stage('promoting', 95, attempt);
      await git(workspace, ['add', '.'], options);
      await git(workspace, ['commit', '--allow-empty', '-m', `Reef: ${run.prompt.slice(0, 100)}`], options);
      const commit = (await git(workspace, ['rev-parse', 'HEAD'], options)).trim();
      const release = await safePath(appRoot(app.id), 'releases', run.id);
      await copyTree(workspace, release, { exclude: excluded });
      await copyTree(path.join(workspace, 'dist'), path.join(release, 'dist'));
      await command(tools.node, [tools.npm, 'ci', '--omit=dev', '--ignore-scripts'], { ...options, cwd: release, env });
      const finalRuntime = await startRuntime(release, path.join(runFolder, 'release-test-data'), tools, signal);
      await finalRuntime.stop();
      await git(repo, ['merge', '--ff-only', commit], options);
      return { id: run.id, commit, createdAt: Date.now() };
    } catch (error) {
      if (signal.aborted || attempt === 2) throw error;
      diagnostics = String(error.message).slice(-16000);
      log(`Verification failed; automatic repair ${attempt + 1}/2.\n${diagnostics}\n`);
    }
  }
  throw new Error('Build did not produce a verified release');
}
