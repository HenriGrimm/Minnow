import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureToolchain, toolchainEnv } from './toolchain.js';
import { command } from './process.js';
import { appRoot, reefRoot, safePath, copyTree, serialize, atomicJson, updateApp } from './store.js';
import { runAgent } from './agent.js';
import { startRuntime } from './runtime.js';
import { hostScript } from './host-scripts.js';
import { isQuotaExhaustedText } from '../generations/quota-error.js';

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

/*
 * A build runs unattended: a failure is retried from its checkpoint unless only the
 * user can clear it. Every budget lives in checkpoint.json, so an automatic resume
 * after a restart cannot reset it into an endless loop; advancing a phase refills
 * the retry and continuation budgets, never the repair budget.
 */
export const MAX_REPAIRS = 4;
export const MAX_RETRIES = 8;
export const MAX_CONTINUATIONS = 6;
export const STALL_MS = 15 * 60000;
export const retryDelay = count => Math.min(15000 * 2 ** (count - 1), 5 * 60000);
const continuePrompt = '\nContinue the partially implemented app in a fresh context. Inspect the existing files first. Continue from the saved work, preserve completed behavior, and finish what remains; do not repeat the plan or rewrite completed files unnecessarily.';
const stopForUser = (message, reason) => Object.assign(new Error(message), { stopReason: reason });

/** Plain-language reason when only the user can clear a failure; empty when a retry may. */
export function needsUser(error) {
  if (error?.stopReason) return error.stopReason;
  const message = String(error?.message ?? error);
  if (isQuotaExhaustedText(message) || /HTTP 402|insufficient balance|payment required/i.test(message)) return 'Your model provider is out of credit or usage. Top it up, then retry.';
  if (/HTTP 40[13]\b|unauthori[sz]ed|invalid api key|not (?:logged|signed) in|authentication (?:failed|required)|please (?:log|sign) in/i.test(message)) return 'Your model provider rejected the sign-in. Reconnect it, then retry.';
  if (/no model configured|model not found|unknown model/i.test(message)) return 'The build model is unavailable. Pick another model, then retry.';
  if (/spawn \S*git(?:\.exe)? ENOENT/i.test(message)) return 'Reef needs Git. Install Git, then retry.';
  return '';
}
const contextExhausted = error => /context budget exceeded/i.test(String(error?.message));
/** Machine trouble a code change cannot fix, so it must not spend a repair. */
const infrastructure = error => Boolean(error?.infrastructure || error?.stalled)
  || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|network (?:error|request)|fetch failed|Command timed out/i.test(String(error?.message));
/** The retry banner shows this; the raw error stays in the build log. */
function describeSnag(error) {
  const message = String(error?.message ?? error);
  if (error?.stalled) return 'The agent went quiet.';
  if (/rate.?limit|resource_exhausted|too many requests|overloaded|HTTP 429|HTTP 5\d\d|process limit/i.test(message)) return 'The model provider is busy.';
  if (infrastructure(error)) return 'The network dropped out.';
  if (/exited with code|without a completion event|did not write its result/i.test(message)) return 'The agent stopped unexpectedly.';
  return 'The last attempt hit a snag.';
}
const asInfrastructure = error => Object.assign(error instanceof Error ? error : new Error(String(error)), { infrastructure: true });
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** One attempt's signal: the run's own abort, or no output for stallMs (a hung CLI or model). */
function watchAttempt(signal, stallMs) {
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal.aborted) forward(); else signal.addEventListener('abort', forward, { once: true });
  let last = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - last < stallMs) return;
    controller.abort(Object.assign(new Error(`No build activity for ${Math.round(stallMs / 60000)} minutes`), { stalled: true }));
  }, Math.max(10, Math.min(30000, stallMs / 4)));
  timer.unref?.();
  return { signal: controller.signal, touch() { last = Date.now(); },
    dispose() { clearInterval(timer); signal.removeEventListener('abort', forward); } };
}

export async function buildApp({ app, run, baseUrl, signal, stage, log, stream, event, retrying, agent = runAgent,
  toolchain = ensureToolchain, execute = command, browserTools = ensureBrowserTools, runtimeHost = startRuntime,
  wait = pause, stallMs = STALL_MS }) {
  const options = { signal, log };
  const repo = await safePath(appRoot(app.id), 'repo');
  const workspace = await safePath(appRoot(app.id), 'worktrees', run.id);
  const runFolder = await safePath(appRoot(app.id), 'runs', run.id);
  await fs.mkdir(runFolder, { recursive: true });
  const checkpointFile = path.join(runFolder, 'checkpoint.json');
  const workspaceGone = () => stopForUser('The saved build workspace is unavailable. Use Reset whole build.', 'The saved build files are missing. Start over to build it again.');
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
      catch { throw workspaceGone(); }
      if (!['planning'].includes(checkpoint.phase)) {
        try { checkpoint.plan = await fs.readFile(path.join(runFolder, 'plan.txt'), 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; throw stopForUser('The saved build plan is unavailable. Use Reset whole build.', 'The saved build plan is missing. Start over to build it again.'); }
      }
      if (run.recovery === 'reset-phase') throw stopForUser('This older build has no phase checkpoint. Retry to keep its files, or use Reset whole build.', 'This older build cannot reset one phase. Retry to keep its files, or start over.');
    }
    await atomicJson(checkpointFile, checkpoint);
  }
  if (checkpoint.phase !== 'scaffolding') {
    try { await fs.access(path.join(workspace, '.git')); }
    catch { throw workspaceGone(); }
  }
  const resumed = Boolean(run.recovery);
  if (run.recovery === 'reset-phase' && checkpoint.phase !== 'scaffolding') {
    if (!checkpoint.sourceTree) throw stopForUser('This build has no phase checkpoint. Use Reset whole build.', 'This build cannot reset one phase. Start over instead.');
    await git(workspace, ['add', '.'], options);
    await git(workspace, ['read-tree', '--reset', '-u', checkpoint.sourceTree], options);
    await git(workspace, ['clean', '-fd'], options);
    log?.(`Reset ${checkpoint.phase} to its saved starting point.\n`);
  }
  await updateApp(app.id, current => { const saved = current.runs.find(item => item.id === run.id); if (saved) delete saved.recovery; });
  async function save(updates) {
    checkpoint = { ...checkpoint, ...updates };
    await atomicJson(checkpointFile, checkpoint);
  }
  async function nextPhase(phase, updates = {}) {
    let sourceTree;
    if (phase !== 'scaffolding') {
      await git(workspace, ['add', '.'], options);
      sourceTree = (await git(workspace, ['write-tree'], options)).trim();
    }
    await save({ ...updates, phase, sourceTree, retries: 0, continuations: 0, continued: false });
  }
  const progress = { scaffolding: 3, planning: 10, building: 20, repairing: 20, installing: 60, checking: 70, promoting: 95 };
  let tools;
  while (true) {
    signal.throwIfAborted();
    const { phase, attempt = 0, diagnostics } = checkpoint;
    await stage(phase, progress[phase], attempt);
    const watch = watchAttempt(signal, stallMs);
    const live = { signal: watch.signal, log: text => { watch.touch(); log?.(text); } };
    const agentInput = { app, runId: run.id, workspace, baseUrl, ...live,
      stream: stream && (text => { watch.touch(); stream(text); }),
      event: event && (value => { watch.touch(); event(value); }) };
    try {
      tools ??= await toolchain(live).catch(error => { throw asInfrastructure(error); });
      const env = toolchainEnv(tools);
      if (phase === 'scaffolding') {
        await execute('git', ['--version'], live);
        try { await fs.access(path.join(repo, '.git')); }
        catch {
          await copyTree(path.join(directory, 'template'), repo);
          await git(repo, ['init', '-b', 'main'], live);
        }
        try { await git(repo, ['rev-parse', 'HEAD'], live); }
        catch {
          await git(repo, ['add', '.'], live);
          await git(repo, ['commit', '-m', 'Initialize Reef utility'], live);
        }
        if ((await git(repo, ['status', '--porcelain'], live)).trim()) throw stopForUser('The app repository has uncommitted changes. Commit them in Code before building a revision.', 'The app has uncommitted changes. Commit them in Code, then retry.');
        await fs.mkdir(path.dirname(workspace), { recursive: true });
        try { await fs.access(path.join(workspace, '.git')); }
        catch { await git(repo, ['worktree', 'add', '--detach', workspace, 'HEAD'], live); }
        await nextPhase('planning');
      } else if (phase === 'planning') {
        const plan = await agent({ ...agentInput, phase: 'plan', prompt: `${contract}\nYou are the Planner. A separate Builder with a fresh context implements your plan. Return a concise implementation plan and meaningful acceptance tests (aim for under 8000 characters). Describe files, behavior, and checks; omit full source listings.\nRequest: ${run.prompt}` });
        await fs.writeFile(path.join(runFolder, 'plan.txt'), plan.text);
        await nextPhase('building', { plan: plan.text });
      } else if (phase === 'building' || phase === 'repairing') {
        // A continuation reads existing files in a fresh chat, never the failed or exhausted history.
        await agent({ ...agentInput, phase: 'build', prompt: `${contract}\nYou are the Builder. Work in small file batches and keep responses concise; do not repeat full file contents in prose.\nRequest: ${run.prompt}\nPlan from the separate Planner: ${checkpoint.plan}\n${diagnostics ? `Repair these verification failures:\n${diagnostics}` : 'Implement now.'}${resumed || checkpoint.continued ? continuePrompt : ''}` });
        await nextPhase('installing');
      } else if (phase === 'installing') {
        await checkProject(workspace);
        await execute(tools.node, [tools.npm, 'install', '--package-lock-only', '--ignore-scripts'], { ...live, cwd: workspace, env });
        await execute(tools.node, [tools.npm, 'ci', '--ignore-scripts'], { ...live, cwd: workspace, env });
        await checkRuntimeDependencies(workspace);
        await nextPhase('checking');
      } else if (phase === 'checking') {
        const tests = await checkProject(workspace);
        await execute(tools.node, ['node_modules/typescript/bin/tsc', '--noEmit'], { ...live, cwd: workspace, env });
        const testOutput = await execute(tools.node, ['--test', ...tests.map(name => `test/${name}`)], { ...live, cwd: workspace, env });
        if (!/(?:# tests |ℹ tests )([1-9]\d*)/.test(testOutput)) throw new Error('No functional tests ran');
        await execute(tools.node, ['node_modules/vite/bin/vite.js', 'build', '--base=./'], { ...live, cwd: workspace, env });
        const browser = await browserTools(tools, live).catch(error => { throw asInfrastructure(error); });
        const runtime = await runtimeHost(workspace, path.join(runFolder, 'test-data'), tools, watch.signal);
        try {
          await execute(tools.node, [await hostScript('verify-browser.mjs'), browser.entry, runtime.url, path.join(workspace, 'reef.scenarios.json'), path.join(runFolder, 'preview.png')], { ...live, env: browser.env, timeout: 180000 });
        } finally { await runtime.stop(); }
        await nextPhase('promoting');
      } else if (phase === 'promoting') {
        if (!checkpoint.commit) {
          await git(workspace, ['add', '.'], live);
          await git(workspace, ['commit', '--allow-empty', '-m', `Reef: ${run.prompt.slice(0, 100)}`], live);
          await save({ commit: (await git(workspace, ['rev-parse', 'HEAD'], live)).trim() });
        }
        const release = await safePath(appRoot(app.id), 'releases', run.id);
        if (app.release?.id !== run.id) await fs.rm(release, { recursive: true, force: true });
        await copyTree(workspace, release, { exclude: excluded });
        await copyTree(path.join(workspace, 'dist'), path.join(release, 'dist'));
        await execute(tools.node, [tools.npm, 'ci', '--omit=dev', '--ignore-scripts'], { ...live, cwd: release, env });
        const finalRuntime = await runtimeHost(release, path.join(runFolder, 'release-test-data'), tools, watch.signal);
        await finalRuntime.stop();
        await git(repo, ['merge', '--ff-only', checkpoint.commit], live);
        return { id: run.id, commit: checkpoint.commit, createdAt: Date.now() };
      } else throw stopForUser('Unknown saved build phase. Use Reset whole build.', 'This build was saved by a different version of Reef. Start over to build it again.');
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = needsUser(error);
      if (reason) throw Object.assign(error, { stopReason: reason });
      if (contextExhausted(error) && ['building', 'repairing'].includes(phase)) {
        const continuations = (checkpoint.continuations ?? 0) + 1;
        if (continuations > MAX_CONTINUATIONS) {
          // The files are saved; failing checks now tell a fresh Builder exactly what is left.
          log?.(`Builder context exhausted ${MAX_CONTINUATIONS} times. Verifying the saved work so its failures direct the rest.\n`);
          await nextPhase('installing');
        } else {
          log?.(`Builder context exhausted. Continuing from saved files with a fresh Builder context (${continuations}/${MAX_CONTINUATIONS}).\n`);
          await save({ continuations, continued: true });
        }
        continue;
      }
      const machine = infrastructure(error) || (phase === 'installing' && /Command timed out/.test(String(error?.message)));
      if (['installing', 'checking'].includes(phase) && !machine) {
        if (attempt >= MAX_REPAIRS) throw Object.assign(error, { stopReason: `Your app still failed its checks after ${MAX_REPAIRS} automatic fixes.` });
        const failures = String(error?.message ?? error).slice(-16000);
        log?.(`Verification failed; automatic repair ${attempt + 1}/${MAX_REPAIRS}.\n${failures}\n`);
        await nextPhase('repairing', { attempt: attempt + 1, diagnostics: failures });
        continue;
      }
      const retries = (checkpoint.retries ?? 0) + 1, snag = describeSnag(error);
      if (retries > MAX_RETRIES) throw Object.assign(error, { stopReason: `${snag} It kept happening after ${MAX_RETRIES} automatic retries.` });
      const delay = retryDelay(retries);
      log?.(`${String(error?.message ?? error).slice(-2000)}\n${snag} Retrying automatically in ${Math.round(delay / 1000)}s (${retries}/${MAX_RETRIES}).\n`);
      await save({ retries, continued: checkpoint.continued || ['building', 'repairing'].includes(phase) });
      await retrying?.({ at: Date.now() + delay, count: retries, max: MAX_RETRIES, reason: snag });
      await wait(delay, signal);
    } finally { watch.dispose(); }
  }
}
