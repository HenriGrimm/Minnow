import { runWithToolContext, resolveSafePath } from '../runtime/path-access.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateDraftAccept, draftContentSha256 } from './draft-accept.js';

export function artifactPaths(state) {
  const slug = state.slug || state.runId;
  return {
    specPath: state.specPath || `documentation/plans/references/${slug}-spec.md`,
    researchPath: state.researchPath || `documentation/plans/references/${slug}-research.md`,
    planPath: state.planPath || `documentation/plans/${slug}.md`,
  };
}

export async function checkStageArtifact(state, role) {
  const paths = artifactPaths(state);
  const relative = role === 'interview' ? paths.specPath : role === 'research' ? paths.researchPath : paths.planPath;
  const absolute = await runWithToolContext(() => resolveSafePath(relative, { write: true }), { workspaceRoot: state.workspacePath, allowOutsideWorkspace: false });
  const boundary = path.relative(path.resolve(state.workspacePath, 'documentation/plans'), absolute);
  if (boundary.startsWith('..') || path.isAbsolute(boundary)) throw new Error('artifact must be under documentation/plans');
  let markdown = null;
  try { markdown = await readFile(absolute, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (role === 'draft' || role === 'polish') {
    const result = evaluateDraftAccept({ markdown, planPath: relative, priorAcceptedSha256: role === 'draft' ? state.planSha256 : null });
    if (!result.accepted) return { errors: result.errors };
  } else if (!markdown?.trim()) return { errors: [`Write a non-empty artifact to ${relative}.`] };
  return { artifact: { path: relative, sha256: draftContentSha256(markdown), involvesUi: /\b(ui|ux|frontend|css|layout|dashboard|screen|component|interface|impeccable)\b/i.test(markdown) } };
}

export async function ensurePromptSpec(state) {
  const relative = artifactPaths(state).specPath;
  const absolute = await runWithToolContext(() => resolveSafePath(relative, { write: true }), { workspaceRoot: state.workspacePath, allowOutsideWorkspace: false });
  await mkdir(path.dirname(absolute), { recursive: true });
  try { await writeFile(absolute, `# Build specification\n\n${state.prompt}\n`, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return { path: relative };
}

export async function confirmSpecIdentity(state) {
  if (!state.specPath) return [];
  const absolute = await runWithToolContext(() => resolveSafePath(state.specPath), { workspaceRoot: state.workspacePath, allowOutsideWorkspace: false });
  const text = await readFile(absolute, 'utf8');
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  if (!title) return [];
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
  if (!base) return [];
  const slug = `${base}-${state.runId.slice(-8)}`;
  const next = `documentation/plans/references/${slug}-spec.md`;
  if (next !== state.specPath) {
    const dest = await runWithToolContext(() => resolveSafePath(next, { write: true }), { workspaceRoot: state.workspacePath, allowOutsideWorkspace: false });
    await writeFile(dest, text, { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  }
  return [{ type: 'slug.assigned', slug, displayTitle: title }, { type: 'spec.written', path: next }];
}
