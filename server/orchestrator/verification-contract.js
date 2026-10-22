/** Requirements derive from the journaled task spec, so edits invalidate them. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizePrerequisites, prerequisiteError } from './prerequisites.js';
import { commitWorktree } from '../worktree/worktree-ops.js';

/** A plan's Inputs section explicitly authorizes staging those exact files in
 * the isolated board. Never stage, commit or overwrite the user's workspace. */
export async function prepareVerificationInputs({ workspace, cwd, markdown, boardId }) {
  const sections = [...markdown.matchAll(/^## (?:Inputs|Reference assets)\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
  const names = [...new Set(sections.flatMap(section => [...section[1].matchAll(/`([^`\r\n]+)`/g)].map(match => match[1])))];
  const copied = [];
  const declared = [];
  const root = await fs.realpath(workspace);
  for (const name of names) {
    let prerequisite;
    try { [prerequisite] = normalizePrerequisites([{ kind: 'file', path: name }]); }
    catch { throw prerequisiteError(`Plan input must name a workspace-relative file: ${name}`, []); }
    const target = path.resolve(cwd, name);
    declared.push(name);
    try {
      const existing = await fs.realpath(target);
      const relative = path.relative(await fs.realpath(cwd), existing);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(target)).isFile()) throw prerequisiteError(`Plan input destination is outside isolation or is not a file: ${name}`, []);
      continue;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let source;
    try { source = await fs.realpath(path.resolve(root, prerequisite.path)); }
    catch { throw prerequisiteError(`Required plan input is missing: ${name}`, [prerequisite]); }
    const relative = path.relative(root, source);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(source)).isFile()) throw prerequisiteError(`Plan input is outside this workspace or is not a file: ${name}`, []);
    // Reject existing parent symlinks rather than copying outside isolation.
    let parent = cwd;
    for (const part of path.relative(cwd, path.dirname(target)).split(path.sep).filter(Boolean)) {
      parent = path.join(parent, part);
      try { if ((await fs.lstat(parent)).isSymbolicLink()) throw prerequisiteError(`Plan input destination crosses a symlink: ${name}`, []); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    copied.push(name);
  }
  if (declared.length) {
    // Also commit a previously copied prefix after interruption before commit.
    const committed = await commitWorktree({ boardId, slotId: 'integration', message: 'Stage declared board inputs', paths: declared });
    if (!committed.ok) throw prerequisiteError('Could not stage declared board inputs in the integration checkout.', []);
  }
  return copied;
}
export function taskVerificationContract(task) {
  const specification = `${task.testSpec || task.test || ''}\n${task.accept || ''}`.trim();
  if (!specification) return [];
  return [{ id: `${task.id}:${createHash('sha256').update(specification).digest('hex').slice(0, 12)}`, owner: 'tester', required: true, specification }];
}
export function validateVerificationChecks(raw, contract) {
  if (!Array.isArray(raw) || raw.length > 64) return 'Include checks for every required verification ID, with outcome and concrete evidence.';
  for (const requirement of contract) {
    const matching = raw.filter((check) => check?.id === requirement.id);
    if (matching.length !== 1 || matching[0].outcome !== 'pass' || !Array.isArray(matching[0].evidence) || !matching[0].evidence.length || !matching[0].evidence.every((value) => typeof value === 'string' && value.trim())) return `Required check ${requirement.id} must pass with command/observation evidence. Report blocked if it cannot run; do not waive acceptance.`;
  }
  return null;
}
