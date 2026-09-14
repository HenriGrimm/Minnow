/** Final Tester static ladder, then the browser rung. */

import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_MAX_OUTPUT_CHARS } from '../tools/output-cap.js';
import {
  DEFAULT_RUNG_TIMEOUT_MS as BROWSER_RUNG_TIMEOUT_MS,
  runBrowserRung,
} from './browser-rung.js';
import { resolveOrchestratorCwd } from './resolve-cwd.js';

const execAsync = promisify(exec);

/** Static rungs, in gate order. `browser` is the fifth and runs only after them. */
export const LADDER_RUNG_IDS = /** @type {const} */ (['typecheck', 'lint', 'unit', 'build']);

/** Every rung, including the browser. */
export const ALL_RUNG_IDS = /** @type {const} */ ([...LADDER_RUNG_IDS, 'browser']);

/** Repo defaults when the plan has no Verification Checklist mapping. */
export const DEFAULT_RUNG_COMMANDS = {
  typecheck: 'npx tsc --noEmit',
  lint: 'npm run lint',
  unit: 'npm test',
  build: 'npm run build',
};

/** Where a recorded baseline may live inside the integration checkout. */
export const BASELINE_RELATIVE_PATHS = [
  'documentation/plans/final-test-baseline.json',
  path.join('.minnow', 'final-test-baseline.json'),
];

const CHECKLIST_HEADING = /^## Verification Checklist\b/m;
const NEXT_HEADING = /^## /m;
const BACKTICK_CMD = /`([^`]+)`/g;

/** Per-rung exec budget. Fixture scripts return immediately; real repos may not. */
const DEFAULT_RUNG_TIMEOUT_MS = 120_000;

/**
 * @typedef {'typecheck' | 'lint' | 'unit' | 'build'} LadderRungId
 *
 * @typedef {object} LadderRung
 * @property {LadderRungId} id
 * @property {string} command
 *
 * @typedef {object} RungBaseline
 * @property {number} [expectedExitCode]
 * @property {string[]} [failingPatterns]
 *
 * @typedef {Partial<Record<LadderRungId, RungBaseline>>} FinalTestBaseline
 *
 * @typedef {object} LadderResult
 * @property {'pass' | 'fail'} outcome
 * @property {string} runInstructions
 * @property {string} summary
 * @property {Record<string, unknown>} evidence
 */

/**
 * `runInstructions` is command + cwd, two labelled lines, so a human (or a test) can exec the same command in the same directory and get the.
 * @param {{ command: string, cwd: string }} input
 * @returns {string}
 */
export function formatRunInstructions(input) {
  const command = String(input?.command ?? '').trim();
  const cwd = String(input?.cwd ?? '').trim();
  return `command: ${command}\ncwd: ${cwd}`;
}

/**
 * Inverse of {@link formatRunInstructions}, and of the browser rung's longer form.
 * @param {string} text
 * @returns {{ command: string, cwd: string, url?: string, steps?: string[] } | null}
 */
export function parseRunInstructions(text) {
  const raw = String(text ?? '');
  const command = raw.match(/^command:\s*(.*)$/m)?.[1]?.trim();
  const cwd = raw.match(/^cwd:\s*(.*)$/m)?.[1]?.trim();
  if (!command || !cwd) return null;
  const url = raw.match(/^url:\s*(.*)$/m)?.[1]?.trim();
  const steps = [...raw.matchAll(/^\s+\d+\.\s+(.*)$/gm)].map((m) => m[1].trim());
  return {
    command,
    cwd,
    ...(url ? { url } : {}),
    ...(steps.length > 0 ? { steps } : {}),
  };
}

/**
 * Cap journal/evidence output so a noisy failing suite cannot bloat the log.
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function capLadderOutput(text, max = DEFAULT_MAX_OUTPUT_CHARS) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 14))}\n…[truncated]`;
}

/**
 * Classify a checklist / package.json command into a named rung.
 *
 * @param {string} command
 * @returns {LadderRungId | null}
 */
export function classifyLadderCommand(command) {
  const c = String(command ?? '').trim();
  if (!c) return null;
  if (/\btsc\b/i.test(c) || /typecheck/i.test(c)) return 'typecheck';
  if (/\blint\b/i.test(c)) return 'lint';
  if (/\bbuild\b/i.test(c)) return 'build';
  if (/\bnpm(?:\.cmd)?\s+test\b/i.test(c) || /\bunit\b/i.test(c) || /\btest\b/i.test(c)) {
    return 'unit';
  }
  return null;
}

/**
 * Pull `## Verification Checklist` commands out of a plan.
 * @param {string} markdown
 * @returns {Partial<Record<LadderRungId, string>>}
 */
export function parseVerificationChecklist(markdown) {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n');
  const start = text.search(CHECKLIST_HEADING);
  if (start < 0) return {};
  const afterHeading = text.slice(start).split('\n').slice(1).join('\n');
  const endRel = afterHeading.search(NEXT_HEADING);
  const body = endRel >= 0 ? afterHeading.slice(0, endRel) : afterHeading;

  /** @type {Partial<Record<LadderRungId, string>>} */
  const mapped = {};
  BACKTICK_CMD.lastIndex = 0;
  let match = BACKTICK_CMD.exec(body);
  while (match) {
    const command = match[1].trim();
    const id = classifyLadderCommand(command);
    if (id && mapped[id] == null) mapped[id] = command;
    match = BACKTICK_CMD.exec(body);
  }
  return mapped;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function packageScripts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const scripts = /** @type {{ scripts?: unknown }} */ (raw).scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === 'string' && value.trim()) out[key] = value;
  }
  return out;
}

/**
 * Prompt-facing list of the rungs the agent must run, in order.
 *
 * @param {LadderRung[]} rungs
 * @returns {string}
 */
export function formatLadderPromptBlock(rungs) {
  return (rungs ?? [])
    .map((rung, index) => `${index + 1}. **${rung.id}** — \`${rung.command}\``)
    .join('\n');
}

/**
 * Resolve named rungs in gate order.
 * @param {{
 *   planMarkdown?: string | null,
 *   packageJson?: unknown,
 * }} [input]
 * @returns {LadderRung[]}
 */
export function resolveLadderRungs(input = {}) {
  const fromPlan = parseVerificationChecklist(input.planMarkdown ?? '');
  const scripts = packageScripts(input.packageJson);

  /** @type {LadderRung[]} */
  const rungs = [];

  const typecheck =
    fromPlan.typecheck ||
    (scripts.typecheck ? 'npm run typecheck' : DEFAULT_RUNG_COMMANDS.typecheck);
  rungs.push({ id: 'typecheck', command: typecheck });

  const lint = fromPlan.lint || (scripts.lint ? 'npm run lint' : null);
  if (lint) rungs.push({ id: 'lint', command: lint });

  const unit = fromPlan.unit || (scripts.test ? 'npm test' : DEFAULT_RUNG_COMMANDS.unit);
  rungs.push({ id: 'unit', command: unit });

  const build =
    fromPlan.build || (scripts.build ? 'npm run build' : DEFAULT_RUNG_COMMANDS.build);
  rungs.push({ id: 'build', command: build });

  return rungs;
}

/**
 * A non-zero exit is a regression unless a recorded baseline says this rung already failed this way.
 * @param {LadderRungId} rungId
 * @param {{ exitCode: number, output: string }} actual
 * @param {FinalTestBaseline | null | undefined} baseline
 * @returns {boolean}
 */
export function matchesKnownBaseline(rungId, actual, baseline) {
  if (!baseline || typeof baseline !== 'object') return false;
  const spec = baseline[rungId];
  if (!spec || typeof spec !== 'object') return false;
  const exitCode = Number(actual.exitCode);
  if (exitCode === 0) return true;
  if (typeof spec.expectedExitCode === 'number' && exitCode !== spec.expectedExitCode) {
    return false;
  }
  const patterns = Array.isArray(spec.failingPatterns) ? spec.failingPatterns : [];
  if (patterns.length === 0) {
    return typeof spec.expectedExitCode === 'number';
  }
  const output = String(actual.output ?? '');
  return patterns.every((p) => p && output.includes(p));
}

/**
 * @param {string} cwd
 * @returns {Promise<unknown | null>}
 */
async function readJsonIfPresent(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd
 * @returns {Promise<FinalTestBaseline | null>}
 */
export async function loadFinalTestBaseline(cwd) {
  const root = path.resolve(cwd);
  for (const rel of BASELINE_RELATIVE_PATHS) {
    const parsed = await readJsonIfPresent(path.join(root, rel));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return /** @type {FinalTestBaseline} */ (parsed);
    }
  }
  return null;
}

/**
 * @param {string} cwd
 * @param {string | null | undefined} planPath
 * @returns {Promise<string>}
 */
export async function loadPlanMarkdown(cwd, planPath) {
  const root = path.resolve(cwd);
  const candidates = [];
  if (typeof planPath === 'string' && planPath.trim()) {
    candidates.push(path.isAbsolute(planPath) ? planPath : path.join(root, planPath));
  }
  candidates.push(path.join(root, 'documentation', 'plans', 'plan.md'));
  for (const file of candidates) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
    }
  }
  return '';
}

/**
 * Plan checklists name bare binaries (`tsc --noEmit`), which only resolve under
 * `npm run`. Put the checkout's `node_modules/.bin` first on PATH the same way,
 * so a rung never fails as "'tsc' is not recognized".
 * @param {string} cwd
 * @returns {NodeJS.ProcessEnv}
 */
export function ladderEnv(cwd) {
  const env = { ...process.env, CI: '1', npm_config_progress: 'false' };
  // Windows spells it `Path`; keep whichever key exists so we don't add a second.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const bin = path.join(path.resolve(cwd), 'node_modules', '.bin');
  env[key] = env[key] ? `${bin}${path.delimiter}${env[key]}` : bin;
  return env;
}

/**
 * @param {string} command
 * @param {{ cwd: string, timeoutMs?: number, signal?: AbortSignal }} opts
 * @returns {Promise<{ exitCode: number, output: string }>}
 */
export async function execLadderCommand(command, opts) {
  const cwd = path.resolve(opts.cwd);
  const timeout = opts.timeoutMs ?? DEFAULT_RUNG_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
      shell: true,
      signal: opts.signal,
      env: ladderEnv(cwd),
    });
    return {
      exitCode: 0,
      output: capLadderOutput(`${stdout || ''}${stderr ? `\n${stderr}` : ''}`),
    };
  } catch (err) {
    const error = /** @type {NodeJS.ErrnoException & { stdout?: string, stderr?: string, code?: unknown }} */ (
      err
    );
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const output = capLadderOutput(
      `${stdout}${stderr ? `\n${stderr}` : ''}${!stdout && !stderr ? error.message || String(err) : ''}`,
    );
    let exitCode = 1;
    if (typeof error.code === 'number') exitCode = error.code;
    else if (error.code === 'ABORT_ERR') exitCode = 1;
    return { exitCode, output };
  }
}

/**
 * The browser rung, under a whole-rung ceiling.
 * @param {{
 *   cwd: string,
 *   planMarkdown: string,
 *   signal?: AbortSignal,
 *   browserRung?: typeof runBrowserRung,
 *   browserOptions?: Record<string, unknown>,
 *   browserTimeoutMs?: number,
 * }} input
 * @returns {Promise<import('./browser-rung.js').BrowserRungResult>}
 */
async function runBrowserRungGuarded(input) {
  const cwd = resolveOrchestratorCwd(input.cwd);
  const rung = input.browserRung ?? runBrowserRung;
  const ceiling = input.browserTimeoutMs ?? BROWSER_RUNG_TIMEOUT_MS;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {import('./browser-rung.js').BrowserRungResult} */
  const timedOut = {
    status: 'blocked',
    reason: 'driver-error',
    summary: `Browser rung blocked: it did not finish within ${ceiling}ms.`,
    runInstructions: formatRunInstructions({ command: '(browser rung timed out)', cwd }),
    url: null,
    appCommand: null,
    port: null,
    assertions: [],
    notObservable: [],
    screenshots: [],
  };
  try {
    const work = Promise.resolve(
      rung({
        cwd,
        planMarkdown: input.planMarkdown,
        signal: input.signal,
        ...(input.browserOptions ?? {}),
      }),
    ).catch((err) => ({
      ...timedOut,
      summary: `Browser rung blocked: ${err instanceof Error ? err.message : String(err)}.`,
    }));
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(timedOut), ceiling);
      if (timer.unref) timer.unref();
    });
    return /** @type {import('./browser-rung.js').BrowserRungResult} */ (
      await Promise.race([work, deadline])
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run the gated ladder in `cwd` (must be the integration worktree).
 *
 * @param {{
 *   cwd: string,
 *   planPath?: string | null,
 *   planMarkdown?: string | null,
 *   baseline?: FinalTestBaseline | null,
 *   signal?: AbortSignal,
 *   execCommand?: typeof execLadderCommand,
 *   timeoutMs?: number,
 *   browser?: boolean,
 *   browserRung?: typeof runBrowserRung,
 *   browserOptions?: Record<string, unknown>,
 *   browserTimeoutMs?: number,
 * }} input
 * @returns {Promise<LadderResult>}
 */
export async function runFinalLadder(input) {
  const cwd = resolveOrchestratorCwd(input.cwd);
  const planMarkdown =
    input.planMarkdown != null
      ? String(input.planMarkdown)
      : await loadPlanMarkdown(cwd, input.planPath);
  const packageJson = await readJsonIfPresent(path.join(cwd, 'package.json'));
  const rungs = resolveLadderRungs({ planMarkdown, packageJson });
  const baseline =
    input.baseline !== undefined ? input.baseline : await loadFinalTestBaseline(cwd);
  const execCommand = input.execCommand ?? execLadderCommand;

  /** @type {string[]} */
  const ran = [];
  /** @type {Array<{ id: string, command: string, exitCode: number, matchedBaseline?: boolean }>} */
  const rungResults = [];

  for (const rung of rungs) {
    if (input.signal?.aborted) {
      const runInstructions = formatRunInstructions({ command: rung.command, cwd });
      return {
        outcome: 'fail',
        runInstructions,
        summary: `Final ladder aborted before ${rung.id}.`,
        evidence: {
          failedRung: rung.id,
          blockedRung: null,
          ran,
          output: 'aborted',
          cwd,
          rungs: rungResults,
          browser: null,
        },
      };
    }

    const actual = await execCommand(rung.command, {
      cwd,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
    });
    ran.push(rung.id);
    const matchedBaseline = actual.exitCode !== 0 && matchesKnownBaseline(rung.id, actual, baseline);
    rungResults.push({
      id: rung.id,
      command: rung.command,
      exitCode: actual.exitCode,
      outcome: actual.exitCode === 0 || matchedBaseline ? 'pass' : 'fail',
      ...(matchedBaseline ? { matchedBaseline: true } : {}),
    });

    if (actual.exitCode !== 0 && !matchedBaseline) {
      const runInstructions = formatRunInstructions({ command: rung.command, cwd });
      return {
        outcome: 'fail',
        runInstructions,
        summary: `Final ladder failed at ${rung.id}.`,
        evidence: {
          failedRung: rung.id,
          blockedRung: null,
          ran,
          output: actual.output,
          cwd,
          rungs: rungResults,
          browser: null,
        },
      };
    }
  }

  const last = rungs[rungs.length - 1];
  const staticInstructions = formatRunInstructions({
    command: last ? last.command : DEFAULT_RUNG_COMMANDS.build,
    cwd,
  });
  const staticSummary = `Final ladder passed ${ran.join(', ')}.`;

  if (input.browser === false) {
    return {
      outcome: 'pass',
      runInstructions: staticInstructions,
      summary: staticSummary,
      evidence: { failedRung: null, blockedRung: null, ran, output: '', cwd, rungs: rungResults, browser: null },
    };
  }

  const browser = await runBrowserRungGuarded({
    cwd,
    planMarkdown,
    signal: input.signal,
    browserRung: input.browserRung,
    browserOptions: input.browserOptions,
    browserTimeoutMs: input.browserTimeoutMs,
  });

  const browserEvidence = {
    status: browser.status,
    reason: browser.reason,
    summary: browser.summary,
    runInstructions: browser.runInstructions,
    url: browser.url,
    appCommand: browser.appCommand,
    port: browser.port,
    assertions: browser.assertions,
    notObservable: browser.notObservable,
    screenshots: browser.screenshots,
  };

  if (browser.status === 'fail') {
    rungResults.push({
      id: 'browser',
      command: browser.appCommand ?? '(dev server)',
      exitCode: 1,
      outcome: 'fail',
    });
    ran.push('browser');
    return {
      outcome: 'fail',
      runInstructions: browser.runInstructions,
      summary: `Final ladder failed at browser. ${browser.summary}`,
      evidence: {
        failedRung: 'browser',
        blockedRung: null,
        ran,
        output: capLadderOutput(browser.summary),
        cwd,
        rungs: rungResults,
        browser: browserEvidence,
      },
    };
  }

  if (browser.status === 'blocked') {
    rungResults.push({
      id: 'browser',
      command: browser.appCommand ?? '(not started)',
      exitCode: 0,
      outcome: 'blocked',
      reason: browser.reason,
    });
    return {
      outcome: 'pass',
      runInstructions: staticInstructions,
      summary: `${staticSummary} ${browser.summary}`,
      evidence: {
        failedRung: null,
        blockedRung: 'browser',
        ran,
        output: '',
        cwd,
        rungs: rungResults,
        browser: browserEvidence,
      },
    };
  }

  rungResults.push({
    id: 'browser',
    command: browser.appCommand ?? '(dev server)',
    exitCode: 0,
    outcome: 'pass',
  });
  ran.push('browser');
  return {
    outcome: 'pass',
    runInstructions: browser.runInstructions,
    summary: `${staticSummary} ${browser.summary}`,
    evidence: {
      failedRung: null,
      blockedRung: null,
      ran,
      output: '',
      cwd,
      rungs: rungResults,
      browser: browserEvidence,
    },
  };
}

/**
 * Map a ladder result onto the engine's AttemptEnd for role `final`.
 *
 * @param {string} attemptId
 * @param {LadderResult} result
 * @returns {import('./engine.js').AttemptEnd}
 */
export function finalAttemptEnd(attemptId, result) {
  return {
    attemptId,
    taskId: null,
    role: 'final',
    outcome: result.outcome,
    summary: result.summary,
    runInstructions: result.runInstructions,
    evidence: result.evidence,
  };
}
