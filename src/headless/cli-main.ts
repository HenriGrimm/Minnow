/**
 * Headless CLI entry (invoked via bin/minnow.mjs + tsx).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseRunArgs,
  printTopLevelHelp,
  type HeadlessRunCliOptions,
} from './argv';
import {
  openWorkspace,
  closeWorkspace,
  spawnMinnowServer,
  stopSpawnedServer,
  waitForServer,
} from './preflight';
import { runHeadless, serializeHeadlessRunResult, type ActiveHeadlessGeneration } from './runner';
import { installHeadlessFetch, normalizeBaseUrl, resolveHeadlessToken } from './server-context';

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function readStdinPrompt(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function resolveWorkspace(
  workspace: string | null,
  cwd: string,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  if (!workspace) return { ok: true, path: '' };
  const abs = path.isAbsolute(workspace) ? workspace : path.resolve(cwd, workspace);
  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      return { ok: false, message: `Workspace is not a directory: ${abs}` };
    }
  } catch {
    return { ok: false, message: `Workspace does not exist: ${abs}` };
  }
  return { ok: true, path: abs };
}

async function ensureServer(cli: HeadlessRunCliOptions): Promise<number | null> {
  const base = normalizeBaseUrl(cli.baseUrl);
  installHeadlessFetch(base, resolveHeadlessToken(cli.token));
  if (await waitForServer({ baseUrl: base, timeoutSec: 3 })) {
    return null;
  }
  if (!cli.startServer) {
    log(`Server not reachable at ${base} (use --start-server or start npm start)`);
    return 3;
  }
  log('Starting Minnow dev server (BROWSER=none)…');
  spawnMinnowServer({ minnowHome: cli.minnowHome, log });
  const ok = await waitForServer({ baseUrl: base, timeoutSec: cli.serverTimeoutSec, log });
  if (!ok) {
    stopSpawnedServer();
    return 3;
  }
  return null;
}

async function runCommand(cli: HeadlessRunCliOptions): Promise<number> {
  if (cli.stdin && (cli.prompt === '__STDIN__' || !cli.prompt)) {
    cli.prompt = await readStdinPrompt();
    if (!cli.prompt) {
      log('Empty stdin — nothing to run');
      return 2;
    }
  }

  const serverExit = await ensureServer(cli);
  if (serverExit != null) return serverExit;

  const workspaceResolved = await resolveWorkspace(cli.workspace, process.cwd());
  if (workspaceResolved.ok === false) {
    log(workspaceResolved.message);
    return 4;
  }

  const base = normalizeBaseUrl(cli.baseUrl);
  installHeadlessFetch(base, resolveHeadlessToken(cli.token), workspaceResolved.path || '');

  if (workspaceResolved.path) {
    try {
      await openWorkspace(base, workspaceResolved.path);
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
      return 4;
    }
  }

  const controller = new AbortController();
  let activeGeneration: ActiveHeadlessGeneration | null = null;
  let shuttingDown = false;
  const onSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    controller.abort();
    if (activeGeneration) void activeGeneration.cancel();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let result: Awaited<ReturnType<typeof runHeadless>>;
  try {
    result = await runHeadless({
      cli,
      workspaceAbs: workspaceResolved.path || null,
      signal: controller.signal,
      onGenerationChange: (active) => { activeGeneration = active; },
      log,
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const jsonText = serializeHeadlessRunResult(result);

  if (cli.jsonOut) {
    await fs.writeFile(cli.jsonOut, jsonText, 'utf8');
  }

  if (cli.json) {
    process.stdout.write(jsonText);
  } else if (!cli.quiet && result.ok) {
    process.stdout.write(`${result.assistantFinal}\n`);
  } else if (!cli.quiet && !result.ok && result.assistantFinal) {
    process.stdout.write(`${result.assistantFinal}\n`);
  }

  if (workspaceResolved.path) {
    await closeWorkspace(base, workspaceResolved.path);
  }
  stopSpawnedServer();
  return result.exitCode;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printTopLevelHelp();
    process.exit(0);
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub !== 'run') {
    log(`Unknown command: ${sub}`);
    printTopLevelHelp();
    process.exit(2);
  }

  const parsed = parseRunArgs(rest);
  if (parsed.ok === false) {
    if (parsed.message !== 'help') {
      log(parsed.message);
      process.exit(2);
    }
    process.exit(0);
    return;
  }

  const code = await runCommand(parsed.options);
  process.exit(code);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  main().catch((err) => {
    log(err instanceof Error ? err.stack ?? err.message : String(err));
    stopSpawnedServer();
    process.exit(1);
  });
}
