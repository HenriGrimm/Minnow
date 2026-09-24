import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePatch, patchText } from '../../src/lib/apply-patch.mjs';
import { resolveSafePath } from '../runtime/path-access.js';
import { codeChangeFromDiff } from './line-diff-stats.js';

// Refuse symlink traversal even when a lexical path is inside the workspace.
async function checkPath(target) {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Patch path traverses a symbolic link: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}

export async function toolApplyPatch(args) {
  const files = parsePatch(args.patch);
  const plans = [], targets = new Set();
  // Validate every path and every hunk before changing any file.
  for (const file of files) {
    const source = resolveSafePath(file.path, { write: true });
    const destination = file.move ? resolveSafePath(file.move, { write: true }) : source;
    // Repeated Update sections apply to the staged result, not stale disk text.
    // Colliding adds/deletes/moves remain errors; all validation still precedes IO.
    const prior = plans.find(p => p.source === source && p.destination === source);
    if (file.kind === 'Update' && !file.move && prior && prior.after !== null) {
      prior.after = patchText(prior.after, file.hunks, file.path);
      continue;
    }
    for (const target of new Set([source, destination])) {
      const key = process.platform === 'win32' ? target.toLowerCase() : target;
      if (targets.has(key)) throw new Error(`Repeated patch target: ${target}`);
      targets.add(key);
      await checkPath(target);
    }
    let before = null;
    try {
      const bytes = await fs.readFile(source);
      before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (before.includes('\0')) throw new Error(`Cannot patch binary file: ${file.path}`);
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (file.kind === 'Add' ? before !== null : before === null) throw new Error(`Cannot ${file.kind} ${file.path}: ${before === null ? 'file missing' : 'already exists'}`);
    if (destination !== source) {
      try { await fs.lstat(destination); throw new Error(`Move destination already exists: ${file.move}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const after = file.kind === 'Delete' ? null : file.kind === 'Add' ? file.content : patchText(before, file.hunks, file.path);
    const mode = before === null ? undefined : (await fs.stat(source)).mode;
    plans.push({ file, source, destination, before, after, mode, wrote: false, removed: false });
  }
  const applied = [];
  try {
    for (const plan of plans) {
      applied.push(plan);
      if (plan.after !== null) {
        await fs.mkdir(path.dirname(plan.destination), { recursive: true });
        if (plan.before === null || plan.destination !== plan.source) {
          const handle = await fs.open(plan.destination, 'wx', plan.mode);
          plan.wrote = true;
          try { await handle.writeFile(plan.after); } finally { await handle.close(); }
        } else {
          plan.wrote = true;
          await fs.writeFile(plan.destination, plan.after);
        }
      }
      if (plan.after === null || plan.destination !== plan.source) {
        await fs.unlink(plan.source);
        plan.removed = true;
      }
    }
  } catch (error) {
    const failures = [];
    for (const plan of applied.reverse()) {
      try {
        if (plan.before !== null && (plan.removed || (plan.wrote && plan.destination === plan.source))) {
          await fs.writeFile(plan.source, plan.before, { mode: plan.mode });
        } else if (plan.before === null && plan.wrote) await fs.rm(plan.source, { force: true });
        if (plan.destination !== plan.source && plan.wrote) await fs.rm(plan.destination, { force: true });
      } catch (rollback) { failures.push(rollback.message); }
    }
    throw new Error(`${error.message}${failures.length ? `; rollback errors: ${failures.join('; ')}` : ''}`);
  }
  const stats = plans.map(p => codeChangeFromDiff(p.before ?? '', p.after ?? '', p.file.move ?? p.file.path)).filter(Boolean);
  return {
    result: `Applied patch:\n${plans.map(p => `${p.file.kind}: ${p.file.path}${p.file.move ? ` -> ${p.file.move}` : ''}`).join('\n')}`,
    codeChange: {
      source: 'file-tool', paths: [...new Set(files.flatMap(f => f.move ? [f.path, f.move] : [f.path]))],
      additions: stats.reduce((n, s) => n + s.additions, 0),
      deletions: stats.reduce((n, s) => n + s.deletions, 0),
    },
  };
}
