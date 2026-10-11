/**
 * CLI argument parsing for `minnow run` (Node parseArgs).
 */

import { parseArgs } from 'node:util';
import { defaultMinnowLocalOrigin } from '../config/minnow-port.ts';

const DEFAULT_BASE_URL = defaultMinnowLocalOrigin();

export interface HeadlessRunCliOptions {
  prompt: string;
  stdin: boolean;
  baseUrl: string;
  startServer: boolean;
  serverTimeoutSec: number;
  agentId: string | null;
  modeId: string;
  providerId: string | null;
  modelId: string | null;
  workspace: string | null;
  profile: string;
  minnowHome: string | null;
  noApproval: boolean;
  json: boolean;
  jsonOut: string | null;
  quiet: boolean;
  stream?: boolean;
  streamJson?: boolean;
  autoRejectQuestions: boolean;
  persistChat: boolean;
  chatId: string | null;
  chatName: string | null;
  /** Scheduled job subprocess — adds guidance to avoid save_memory noise. */
  schedulerRun: boolean;
  /** Session token override; falls back to MINNOW_TOKEN env, then ~/.minnow/session-token. */
  token: string | null;
}

const RUN_HELP = `minnow run — execute one agent turn without the SPA

Required:
  --prompt <text>       User task (or --stdin to read from stdin)

Server:
  --base-url <url>      Dev server origin (default ${DEFAULT_BASE_URL})
  --start-server        Spawn "node server.js" with BROWSER=none if ping fails
  --server-timeout <s>  Preflight wait in seconds (default 30)

Auth:
  --token <token>       Session token (default: MINNOW_TOKEN env, else ~/.minnow/session-token)

Agent / model:
  --agent <id>          Work agent id (e.g. builder, planner)
  --mode <id>           general | build | plan | orchestrate | debug (default build)
  --provider <id>       Override provider id
  --model <id>          Override model id

Environment:
  --workspace <path>    PUT /api/workspace before run (absolute or cwd-relative)
  --profile <name>      full | lite | custom:<configId>
  --minnow-home <path>  MINNOW_HOME for --start-server child (tests)

Safety:
  --no-approval         Auto-allow tools that would show a modal (requires env below)
  --auto-reject-questions  Return non-interactive error for ask_question (default)

Output:
  --json                Print HeadlessRunResult JSON to stdout
  --json-out <file>     Write JSON artifact to path
  --quiet               Suppress final assistant text (logs on stderr)
  --stream              Stream agent text, reasoning and tool activity to stdout
  --stream-json         Stream runner events as JSON lines (with --json-out)

Session:
  --persist-chat          Save transcript to ~/.minnow sessions (requires --chat-id)
  --chat-id <id>          Chat id to create or update when persisting
  --chat-name <label>     Sidebar title for the persisted chat (default: Headless run)
  --scheduler-run         Scheduled-job context (suppress routine save_memory)

Env:
  MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION=1  Required with --no-approval
  BROWSER=none                             Use with npm start in CI
  MINNOW_HEADLESS=1                          Skips browser open in server.js

Exit codes:
  0 success | 1 run failed | 2 usage | 3 server unavailable | 4 workspace invalid | 130 SIGINT
`;

export function printRunHelp(): void {
  process.stderr.write(RUN_HELP);
}

export function printTopLevelHelp(): void {
  process.stderr.write(`Minnow headless CLI

Usage:
  minnow run [options]     Run one agent turn (see: minnow run --help)

Examples:
  minnow run --prompt "Summarize README.md" --workspace .
  BROWSER=none npm start &
  minnow run --base-url ${DEFAULT_BASE_URL} --prompt "Reply OK" --json
`);
}

/** Parse `run` subcommand argv (after "run" is stripped). */
export function parseRunArgs(argv: string[]): { ok: true; options: HeadlessRunCliOptions } | { ok: false; message: string } {
  if (argv.includes('--help') || argv.includes('-h')) {
    printRunHelp();
    return { ok: false, message: 'help' };
  }

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      prompt: { type: 'string' },
      stdin: { type: 'boolean', default: false },
      'base-url': { type: 'string', default: DEFAULT_BASE_URL },
      'start-server': { type: 'boolean', default: false },
      'server-timeout': { type: 'string', default: '30' },
      token: { type: 'string' },
      agent: { type: 'string' },
      mode: { type: 'string', default: 'build' },
      provider: { type: 'string' },
      model: { type: 'string' },
      workspace: { type: 'string' },
      profile: { type: 'string', default: 'full' },
      'minnow-home': { type: 'string' },
      'no-approval': { type: 'boolean', default: false },
      'auto-reject-questions': { type: 'boolean', default: true },
      json: { type: 'boolean', default: false },
      'json-out': { type: 'string' },
      quiet: { type: 'boolean', default: false },
      stream: { type: 'boolean', default: false },
      'stream-json': { type: 'boolean', default: false },
      'persist-chat': { type: 'boolean', default: false },
      'chat-id': { type: 'string' },
      'chat-name': { type: 'string' },
      'scheduler-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (positionals.length > 0) {
    return { ok: false, message: `Unexpected arguments: ${positionals.join(' ')}` };
  }

  let prompt = typeof values.prompt === 'string' ? values.prompt.trim() : '';
  if (values.stdin) {
    prompt = prompt || '__STDIN__';
  }
  if (!prompt || prompt === '__STDIN__') {
    if (!values.stdin && !values.prompt) {
      return { ok: false, message: 'Missing required --prompt or --stdin' };
    }
  }

  const serverTimeoutSec = Math.max(1, parseInt(String(values['server-timeout'] ?? '30'), 10) || 30);

  const profile = String(values.profile ?? 'full').trim();
  if (
    profile !== 'full' &&
    profile !== 'lite' &&
    !profile.startsWith('custom:')
  ) {
    return {
      ok: false,
      message: '--profile must be full, lite, or custom:<configId>',
    };
  }

  const modeId = String(values.mode ?? 'build').trim().toLowerCase();
  if (modeId === 'orchestrate') {
    return {
      ok: false,
      message:
        'Orchestrate mode is not supported in headless v1 (board UI required). Use build or plan.',
    };
  }

  const persistChat = Boolean(values['persist-chat']);
  if (values.stream && values.json) return { ok: false, message: '--stream cannot be combined with --json; use --json-out for the result artifact' };
  if (values['stream-json'] && (values.json || values.stream)) return { ok: false, message: '--stream-json cannot be combined with --json or --stream; use --json-out for the result artifact' };
  const chatId = values['chat-id'] ? String(values['chat-id']).trim() : null;
  const chatName = values['chat-name'] ? String(values['chat-name']).trim() : null;
  if (persistChat && !chatId) {
    return { ok: false, message: '--persist-chat requires --chat-id' };
  }

  return {
    ok: true,
    options: {
      prompt,
      stdin: Boolean(values.stdin),
      baseUrl: String(values['base-url'] ?? DEFAULT_BASE_URL).trim(),
      startServer: Boolean(values['start-server']),
      serverTimeoutSec,
      agentId: values.agent ? String(values.agent).trim() : null,
      modeId,
      providerId: values.provider ? String(values.provider).trim() : null,
      modelId: values.model ? String(values.model).trim() : null,
      workspace: values.workspace ? String(values.workspace).trim() : null,
      profile,
      minnowHome: values['minnow-home'] ? String(values['minnow-home']).trim() : null,
      noApproval: Boolean(values['no-approval']),
      json: Boolean(values.json),
      jsonOut: values['json-out'] ? String(values['json-out']).trim() : null,
      quiet: Boolean(values.quiet),
      stream: Boolean(values.stream),
      streamJson: Boolean(values['stream-json']),
      autoRejectQuestions: values['auto-reject-questions'] !== false,
      persistChat,
      chatId,
      chatName,
      schedulerRun: Boolean(values['scheduler-run']),
      token: values.token ? String(values.token).trim() : null,
    },
  };
}
