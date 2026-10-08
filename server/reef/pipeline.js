import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureToolchain, toolchainEnv } from './toolchain.js';
import { command } from './process.js';
import { appRoot, reefRoot, safePath, copyTree, serialize, atomicJson, updateApp } from './store.js';
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

/** A continuation reads existing files in a fresh chat, never the exhausted history. */
export async function runBuilderWithRecovery(input, agent = runAgent) {
  for (let continuation = 0; ; continuation++) {
    input.signal.throwIfAborted();
    try {
      return await agent({ ...input, phase: 'build', prompt: `${input.prompt}${continuation ? '\nContinue the partially implemented app in a fresh context. Inspect the existing files first. Preserve completed work and implement what remains; do not repeat the plan or rewrite completed files unnecessarily.' : ''}` });
    } catch (error) {
      if (input.signal.aborted || continuation >= 2 || !/context budget exceeded/i.test(error.message)) throw error;
      input.log?.(`Builder context exhausted. Continuing from saved files with a fresh Builder context (${continuation + 1}/2).\n`);
    }
  }
}

export async function buildApp({ app, run, baseUrl, signal, stage, log, stream, event, agent = runAgent,
  toolchain = ensureToolchain, execute = command, browserTools = ensureBrowserTools, runtimeHost = startRuntime }) {
  const options = { signal, log };
  const tools = await toolchain(options);
  const env = toolchainEnv(tools);
  const repo = await safePath(appRoot(app.id), 'repo');
  const workspace = await safePath(appRoot(app.id), 'worktrees', run.id);
  const runFolder = await safePath(appRoot(app.id), 'runs', run.id);
  await fs.mkdir(runFolder, { recursive: true });
  const checkpointFile = path.join(runFolder, 'checkpoint.json');
  let checkpoint;
  try { checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!checkpoint) {
    checkpoint = { phase: 'scaffolding', attempt: 0, diagnostics: '' };
    const legacyPhase = run.failedStage ?? (run.progress >= 95 ? 'promoting' : run.progress >= 70 ? 'checking'
      : run.progress >= 60 ? 'installing' : run.progress >= 20 ? run.attempt ? 'repairing' : 'building'
        : run.progress >= 10 ? 'planning' : 'scaffolding');
    if (run.recovery && legacyPhase !== 'scaffolding' && legacyPhase !== 'queued') {
      checkpoint.phase = legacyPhase; checkpoint.attempt = run.attempt ?? 0;
      try { await fs.access(path.join(workspace, '.git')); }
      catch { throw new Error('The saved build workspace is unavailable. Use Reset whole build.'); }
      if (!['planning'].includes(checkpoint.phase)) {
        try { checkpoint.plan = await fs.readFile(path.join(runFolder, 'plan.txt'), 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; throw new Error('The saved build plan is unavailable. Use Reset whole build.'); }
      }
      if (run.recovery === 'reset-phase') throw new Error('This older build has no phase checkpoint. Retry to keep its files, or use Reset whole build.');
    }
    await atomicJson(checkpointFile, checkpoint);
  }
  if (checkpoint.phase !== 'scaffolding') {
    try { await fs.access(path.join(workspace, '.git')); }
    catch { throw new Error('The saved build workspace is unavailable. Use Reset whole build.'); }
  }
  const resumed = Boolean(run.recovery);
  if (run.recovery === 'reset-phase' && checkpoint.phase !== 'scaffolding') {
    if (!checkpoint.sourceTree) throw new Error('This build has no phase checkpoint. Use Reset whole build.');
    await git(workspace, ['add', '.'], options);
    await git(workspace, ['read-tree', '--reset', '-u', checkpoint.sourceTree], options);
    await git(workspace, ['clean', '-fd'], options);
    log?.(`Reset ${checkpoint.phase} to its saved starting point.\n`);
  }
  await updateApp(app.id, current => { const saved = current.runs.find(item => item.id === run.id); if (saved) delete saved.recovery; });
  async function nextPhase(phase, updates = {}) {
    let sourceTree;
    if (phase !== 'scaffolding') {
      await git(workspace, ['add', '.'], options);
      sourceTree = (await git(workspace, ['write-tree'], options)).trim();
    }
    const next = { ...checkpoint, ...updates, phase, sourceTree };
    await atomicJson(checkpointFile, next);
    checkpoint = next;
  }
  const progress = { scaffolding: 3, planning: 10, building: 20, repairing: 20, installing: 60, checking: 70, promoting: 95 };
  let repairs = 0;
  while (true) {
    signal.throwIfAborted();
    const { phase, attempt, diagnostics } = checkpoint;
    await stage(phase, progress[phase], attempt);
    try {
      if (phase === 'scaffolding') {
        await execute('git', ['--version'], options);
        try { await fs.access(path.join(repo, '.git')); }
        catch {
          await copyTree(path.join(directory, 'template'), repo);
          await git(repo, ['init', '-b', 'main'], options);
        }
        try { await git(repo, ['rev-parse', 'HEAD'], options); }
        catch {
          await git(repo, ['add', '.'], options);
          await git(repo, ['commit', '-m', 'Initialize Reef utility'], options);
        }
        if ((await git(repo, ['status', '--porcelain'], options)).trim()) throw new Error('The app repository has uncommitted changes. Commit them in Code before building a revision.');
        await fs.mkdir(path.dirname(workspace), { recursive: true });
        try { await fs.access(path.join(workspace, '.git')); }
        catch { await git(repo, ['worktree', 'add', '--detach', workspace, 'HEAD'], options); }
        await nextPhase('planning');
      } else if (phase === 'planning') {
        const plan = await agent({ app, runId: run.id, workspace, baseUrl, signal, log, stream, event, phase: 'plan', prompt: `${contract}\nYou are the Planner. A separate Builder with a fresh context implements your plan. Return a concise implementation plan and meaningful acceptance tests (aim for under 8000 characters). Describe files, behavior, and checks; omit full source listings.\nRequest: ${run.prompt}` });
        await fs.writeFile(path.join(runFolder, 'plan.txt'), plan.text);
        await nextPhase('building', { plan: plan.text });
      } else if (phase === 'building' || phase === 'repairing') {
        await runBuilderWithRecovery({ app, runId: run.id, workspace, baseUrl, signal, log, stream, event, prompt: `${contract}\nYou are the Builder. Work in small file batches and keep responses concise; do not repeat full file contents in prose.\nRequest: ${run.prompt}\nPlan from the separate Planner: ${checkpoint.plan}\n${diagnostics ? `Repair these verification failures:\n${diagnostics}` : 'Implement now.'}${resumed ? '\nInspect existing files first. Continue from the saved work, preserve completed behavior, and finish what remains.' : ''}` }, agent);
        await nextPhase('installing');
      } else if (phase === 'installing') {
        await checkProject(workspace);
        await execute(tools.node, [tools.npm, 'install', '--package-lock-only', '--ignore-scripts'], { ...options, cwd: workspace, env });
        await execute(tools.node, [tools.npm, 'ci', '--ignore-scripts'], { ...options, cwd: workspace, env });
        await checkRuntimeDependencies(workspace);
        await nextPhase('checking');
      } else if (phase === 'checking') {
        const tests = await checkProject(workspace);
        await execute(tools.node, ['node_modules/typescript/bin/tsc', '--noEmit'], { ...options, cwd: workspace, env });
        const testOutput = await execute(tools.node, ['--test', ...tests.map(name => `test/${name}`)], { ...options, cwd: workspace, env });
        if (!/(?:# tests |ℹ tests )([1-9]\d*)/.test(testOutput)) throw new Error('No functional tests ran');
        await execute(tools.node, ['node_modules/vite/bin/vite.js', 'build', '--base=./'], { ...options, cwd: workspace, env });
        const browser = await browserTools(tools, options);
        const runtime = await runtimeHost(workspace, path.join(runFolder, 'test-data'), tools, signal);
        try {
          await execute(tools.node, [await hostScript('verify-browser.mjs'), browser.entry, runtime.url, path.join(workspace, 'reef.scenarios.json'), path.join(runFolder, 'preview.png')], { ...options, env: browser.env, timeout: 180000 });
        } finally { await runtime.stop(); }
        await nextPhase('promoting');
      } else if (phase === 'promoting') {
        if (!checkpoint.commit) {
          await git(workspace, ['add', '.'], options);
          await git(workspace, ['commit', '--allow-empty', '-m', `Reef: ${run.prompt.slice(0, 100)}`], options);
          checkpoint.commit = (await git(workspace, ['rev-parse', 'HEAD'], options)).trim();
          await atomicJson(checkpointFile, checkpoint);
        }
        const release = await safePath(appRoot(app.id), 'releases', run.id);
        if (app.release?.id !== run.id) await fs.rm(release, { recursive: true, force: true });
        await copyTree(workspace, release, { exclude: excluded });
        await copyTree(path.join(workspace, 'dist'), path.join(release, 'dist'));
        await execute(tools.node, [tools.npm, 'ci', '--omit=dev', '--ignore-scripts'], { ...options, cwd: release, env });
        const finalRuntime = await runtimeHost(release, path.join(runFolder, 'release-test-data'), tools, signal);
        await finalRuntime.stop();
        await git(repo, ['merge', '--ff-only', checkpoint.commit], options);
        return { id: run.id, commit: checkpoint.commit, createdAt: Date.now() };
      } else throw new Error('Unknown saved build phase. Use Reset whole build.');
    } catch (error) {
      if (signal.aborted || repairs >= 2 || !['installing', 'checking'].includes(phase)) throw error;
      const diagnostics = String(error.message).slice(-16000);
      repairs++;
      log?.(`Verification failed; automatic repair ${repairs}/2.\n${diagnostics}\n`);
      await nextPhase('repairing', { attempt: repairs, diagnostics });
    }
  }
}
