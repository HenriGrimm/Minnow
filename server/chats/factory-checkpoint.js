import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
  { cwd, windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' })).stdout.trim();

function checkCommand(raw) {
  const command = typeof raw === 'string' ? raw : raw?.command;
  const cwd = path.posix.normalize(String(raw?.cwd || '.').replaceAll('\\', '/'));
  if (typeof command !== 'string' || !command.trim() || command.length > 16000 || /[\r\n\0]/.test(command) ||
      path.win32.isAbsolute(cwd) || cwd === '..' || cwd.startsWith('../')) {
    throw new Error('Use a single check command and a working directory inside this checkout.');
  }
  return { command: command.trim(), cwd };
}

// A change in the committed feature ledger hands ownership to the next factory turn.
export const readFactoryLedger = cwd => git(cwd, 'rev-parse', '--verify', '--quiet', 'HEAD:./factory/progress.json').catch(error => {
  if (error.code === 1) return null;
  throw error;
});

export const readFactoryBranch = cwd => git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => null);

/** Only committed files establish completed steps. Uncommitted work is inspected by the next builder. */
export async function readFactoryCheckpoint(cwd) {
  let branch;
  try { branch = await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'); }
  catch (error) {
    if (error.code === 128 && error.stderr?.includes('not a git repository')) {
      return { branch: null, ready: false, reason: 'Resume initial setup in the original project directory. Inspect existing files and initialize the Git repository if needed.' };
    }
    return { blocked: 'Waiting for Git and the original working branch to be available.' };
  }
  let head;
  try { head = await git(cwd, 'rev-parse', '--verify', '--quiet', 'HEAD'); }
  catch (error) { if (error.code !== 1) throw error; }
  let completed = 0, total = 0;
  const build = reason => ({ branch, head, completed, total, reason, ready: false });
  const files = head ? (await git(cwd, 'ls-tree', '--name-only', head, '--', 'factory/progress.json', 'factory/spec.md', 'factory/REPORT.md')).split('\n') : [];
  if (!files.includes('factory/progress.json')) return build('Inspect existing factory files and Git changes. Resume the first unfinished setup or contract step.');
  let progress, config;
  try {
    progress = JSON.parse(await git(cwd, 'show', head + ':./factory/progress.json'));
    if (!Array.isArray(progress.features) || !progress.features.length) return build('Repair the feature list in factory/progress.json.');
    if (progress.branch && progress.branch !== branch) return { branch, blocked: 'The factory checkpoint belongs to branch ' + progress.branch + '. Restore that branch to resume.' };
    const passed = progress.features.filter(feature => feature?.passes === true);
    completed = passed.length; total = progress.features.length;
    const reviewed = new Set((progress.reviews ?? []).map(review => review.afterFeature));
    const next = progress.features.find(feature => feature?.passes !== true);
    // Review the current boundary. Review fixes extend the list and must not reopen every earlier boundary.
    const last = passed.at(-1);
    const latestReview = (progress.reviews ?? []).at(-1);
    const boundary = latestReview ? passed.findIndex(f => f.id === latestReview.afterFeature) : -1;
    const resolved = new Set(String(latestReview?.resolved || '').match(/\bF\d+\b/g) || []);
    const reviewFixes = boundary >= 0 && passed.slice(boundary + 1)
      .every(f => f.reviewOf === latestReview.afterFeature || resolved.has(f.id));
    if (last && !reviewed.has(last.id) && (completed % 5 === 0 || !next) && !(reviewFixes && !next)) {
      return { ...build('Resume the review checkpoint after ' + last.id + '. Reuse any finished reviewer result, record it in progress.json and commit the checkpoint.'),
        assignment: { role: 'reviewer', id: String(last.id), title: 'Review after ' + last.id, attempt: 0 } };
    }
    if (next) {
      config = JSON.parse(await git(cwd, 'show', head + ':./factory/factory.json'));
      if (![...passed, next].every(f => Array.isArray(f.checks) && f.checks.length) || !Array.isArray(config.gates) || !config.gates.length) {
        return build('Complete the missing feature checks and project gates before assigning a builder.');
      }
      const commands = [...passed.flatMap(f => f.checks), ...next.checks, ...config.gates].map(checkCommand);
      const featureChecks = [...new Map(commands.map(check => [JSON.stringify(check), check])).values()];
      return { featureChecks, ...build('Continue at the first unfinished feature ' + String(next.id ?? next.title ?? '').slice(0, 160) + '. Keep committed passing features.'),
        assignment: { role: 'builder', id: String(next.id), title: String(next.title || next.id).slice(0, 160), attempt: Number(next.attempts) || 0 } };
    }
    const report = files.includes('factory/REPORT.md') && await git(cwd, 'show', head + ':./factory/REPORT.md');
    if (!report || !/^#{1,4}\s+.*(?:how to run|running|launch|getting started|quick start|installation)/im.test(report) ||
        !/^#{1,4}\s+.*(?:next steps|follow[- ]?ups|remaining work)/im.test(report)) return build('Complete the final review, run the checks, and commit factory/REPORT.md with launch instructions and next steps.');
    const spec = files.includes('factory/spec.md') && await git(cwd, 'show', head + ':./factory/spec.md');
    if (!spec) return build('Commit the factory specification with the requested features and acceptance criteria before verification.');
    config = JSON.parse(await git(cwd, 'show', head + ':./factory/factory.json'));
    if (!Array.isArray(config.gates) || !config.gates.length || !Array.isArray(config.full) || !config.full.length ||
        !progress.features.every(f => Array.isArray(f.checks) && f.checks.length)) return build('Record the feature checks, project gates and full suite in the contract before verification.');
    const checks = [...progress.features.flatMap(f => f.checks), ...config.gates, ...config.full].map(checkCommand);
    if (await git(cwd, 'status', '--porcelain=v1', '--untracked-files=normal')) return build('Review outstanding changes and commit the completed work before final verification.');
    const contract = await git(cwd, 'log', '-1', '--format=%H', '--grep=^factory: contract$', head);
    if (!contract) return build('Find and commit the authorized factory contract before verifying.');
    const paths = new Set(['factory/checks', ...progress.features.flatMap(f => f.checkPaths || [])]);
    if ([...paths].some(p => typeof p !== 'string' || !p || p.includes('\\') || path.win32.isAbsolute(p) || p.split('/').includes('..'))) {
      return build('Record the frozen check paths relative to the checkout.');
    }
    const history = await git(cwd, '--literal-pathspecs', 'log', '--format=%s', contract + '..' + head, '--', ...paths);
    if (history && history.split('\n').some(title => !/^factory: amend\s+\S/.test(title))) {
      // Compare each changed file to the last authorized commit that actually touched it.
      const changes = await git(cwd, '--literal-pathspecs', 'log', '--relative', '--format=', '--no-renames', '--name-only', '-z', contract + '..' + head, '--', ...paths);
      // Older runs sometimes introduced additional checks alongside feature fixes. A documented
      // amendment can ratify their existing blobs without rewriting history or editing the checks.
      const named = new Map();
      const amendments = await git(cwd, 'log', '--format=%H%x00%B%x00', '--grep=^factory: amend ', contract + '..' + head);
      const parts = amendments.split('\0');
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const sha = parts[i].trim();
        const files = [...parts[i + 1].matchAll(/^Factory-Check: (.+)$/gm)].map(match => match[1].trim());
        if (!files.length || !(await git(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha, '--', 'factory/decisions.md'))) continue;
        for (const file of files) if (!named.has(file)) named.set(file, sha);
      }
      const conflicts = [];
      for (const file of new Set(changes.split('\0').filter(Boolean))) {
        const approved = await git(cwd, '--literal-pathspecs', 'log', '-1', '--format=%H', '--grep=^factory: amend ', contract + '..' + head, '--', file);
        let base = approved || contract;
        const recorded = named.get(file);
        if (recorded && await git(cwd, 'merge-base', base, recorded) === base) base = recorded;
        if (await git(cwd, '--literal-pathspecs', 'diff', '--name-only', base, head, '--', file)) conflicts.push(file);
      }
      if (conflicts.length) return build('Review frozen checks against the contract at ' + contract.slice(0, 12) + ': ' + conflicts.join(', ').slice(0, 6000) +
        '. Restore weakened checks. For justified changes that preserve the specification, document each diff in factory/decisions.md and commit it as "factory: amend <reason>" with one "Factory-Check: <path>" line per approved file in the commit body. Rerun the checks.');
    }
    if (await git(cwd, 'rev-parse', 'HEAD') !== head || await readFactoryBranch(cwd) !== branch) {
      return { blocked: 'The checkout changed during verification. Checking the current commit again.' };
    }
    return { branch, head, completed, total, report, spec, ready: true, checks: [...new Map(checks.map(c => [JSON.stringify(c), c])).values()] };
  } catch (error) {
    if (error.killed || error.code === 'ENOENT' || error.code === 'EACCES') throw error;
    return build('Inspect and repair the incomplete committed factory contract. ' + String(error.message).split('\n')[0].slice(0, 220));
  }
}

export function factoryCheckPassed(result, command) {
  return !result?.isError && typeof result?.content === 'string' && result.content.split(/\r?\n/, 1)[0] === command + ' (exit 0)';
}

/** Count only the runner's exit header for the exact blocking command and directory. */
export function successfulFactoryChecks(db, executionId, checks) {
  const passed = new Set();
  for (const row of db.prepare("SELECT payload_json, result_json FROM chat_tool_invocations WHERE execution_id=? AND tool_name='execute_command' AND state='settled' ORDER BY created_at, rowid").all(executionId)) {
    const args = JSON.parse(row.payload_json);
    if (!args?.command || args.background || args.stop) continue;
    const key = JSON.stringify({ command: args.command, cwd: path.posix.normalize(String(args.cwd || '.').replaceAll('\\', '/')) });
    const result = JSON.parse(row.result_json);
    if (factoryCheckPassed(result, args.command)) passed.add(key);
    else passed.delete(key);
  }
  return checks.every(check => passed.has(JSON.stringify(check)));
}
