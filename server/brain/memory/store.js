/**
 * Project and user memory records on top of the Brain page store.
 *
 * Layout (pages-relative):
 *   memory/projects/<projectKey>/<slug>.md — one repository and all its worktrees
 *   memory/user/<slug>.md                  — preferences the user applies everywhere
 *
 * Every read and write is confined to the caller's project and the user scope.
 * Limits fail loudly; nothing is evicted silently.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolvePagePath } from '../paths.js';
import {
  createPage,
  deletePage,
  listPages,
  loadBrainConfig,
  readPage,
  rebuildCatalog,
  updatePage,
} from '../store.js';
import { containsSecretPatterns } from '../secret-patterns.js';
import { memorySimilarities } from './similarity.js';
import {
  USER_MEMORY_PREFIX,
  memoryScopeOfPath,
  projectMemoryFolder,
} from './scope.js';

export const MEMORY_KINDS = Object.freeze(['decision', 'constraint', 'gotcha', 'preference', 'reference']);
export const MEMORY_LIMITS = Object.freeze({
  title: 100,
  body: 1200,
  evidence: 300,
  summary: 160,
});
export const DUPLICATE_MIN_COSINE = 0.85;

/** Typed error for rejected memory operations; message is shown to the agent. */
export class MemoryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    Object.assign(this, details);
  }
}

// Serialize memory writes so cap and duplicate checks see each other.
let pending = Promise.resolve();
function serial(work) {
  const next = pending.then(work, work);
  pending = next.catch(() => {});
  return next;
}

const normalizeTitle = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function summarize(body) {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MEMORY_LIMITS.summary ? `${flat.slice(0, MEMORY_LIMITS.summary - 1).trimEnd()}…` : flat;
}

function slugFor(title, id) {
  const base = normalizeTitle(title).replace(/ /g, '-').slice(0, 50).replace(/-+$/g, '') || 'memory';
  return `${base}-${id.slice(0, 8)}`;
}

/** Visible-scope check for a catalog/page path. */
function visibleScope(relPath, project) {
  const scope = memoryScopeOfPath(relPath);
  if (!scope) return null;
  if (scope.scope === 'user') return scope;
  return project?.key && scope.projectKey === project.key ? scope : null;
}

/** Catalog rows for memories visible to `project` (user scope always included). */
export async function listMemories({ project, scope = 'all' } = {}) {
  const pages = await listPages();
  return pages.filter(page => {
    const visible = visibleScope(page.path, project);
    if (!visible) return false;
    return scope === 'all' || visible.scope === scope;
  }).map(page => ({ ...page, scope: memoryScopeOfPath(page.path).scope }));
}

/** Visible memories with bodies, for search and duplicate checks. */
export async function loadMemoryEntries(project, scope = 'all') {
  const rows = await listMemories({ project, scope });
  const entries = [];
  for (const row of rows) {
    try {
      const page = await readPage(row.path);
      entries.push({ meta: { ...page.meta, scope: row.scope }, body: page.body, revision: page.revision });
    } catch {
      /* skip unreadable pages */
    }
  }
  return entries;
}

/** Compact search/list shape. */
export function memoryHit(entry) {
  return {
    id: entry.meta.id,
    title: entry.meta.title,
    kind: entry.meta.kind ?? 'reference',
    scope: entry.meta.scope ?? memoryScopeOfPath(entry.meta.path)?.scope ?? 'project',
    updated: String(entry.meta.updatedAt ?? '').slice(0, 10),
    summary: summarize(entry.body),
  };
}

/** Read one memory by id; refuses ids outside the current project and user scopes. */
export async function readMemory(id, { project } = {}) {
  const lookup = String(id ?? '').trim();
  if (!lookup) throw new MemoryError('invalid', 'id is required (from memory_search).');
  const rows = await listMemories({ project });
  const row = rows.find(page => page.id === lookup);
  if (!row) {
    throw new MemoryError('not_found',
      `No memory with id ${lookup} in this project or your user memory. Use memory_search to find current ids.`);
  }
  const page = await readPage(row.path);
  return { ...page, scope: row.scope, meta: { ...page.meta, scope: row.scope } };
}

function cleanText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

/** Validate fields; returns normalized values. */
function validateFields({ title, body, kind, evidence }) {
  const out = { title: cleanText(title).replace(/\s+/g, ' '), body: cleanText(body), kind: cleanText(kind).toLowerCase(), evidence: cleanText(evidence) };
  if (!out.title) throw new MemoryError('invalid', 'title is required: a specific one-line claim.');
  if (!out.body) throw new MemoryError('invalid', 'body is required: the claim, why it holds and the evidence.');
  if (out.title.length > MEMORY_LIMITS.title) {
    throw new MemoryError('too_long', `title is ${out.title.length} characters; the limit is ${MEMORY_LIMITS.title}. Shorten it to one specific claim.`);
  }
  if (out.body.length > MEMORY_LIMITS.body) {
    throw new MemoryError('too_long', `body is ${out.body.length} characters; the limit is ${MEMORY_LIMITS.body}. Keep one idea per memory and cut detail the code already shows.`);
  }
  if (out.evidence.length > MEMORY_LIMITS.evidence) {
    throw new MemoryError('too_long', `evidence is ${out.evidence.length} characters; the limit is ${MEMORY_LIMITS.evidence}. Cite a file, command or issue.`);
  }
  if (!MEMORY_KINDS.includes(out.kind)) {
    throw new MemoryError('invalid', `kind must be one of: ${MEMORY_KINDS.join(', ')}.`);
  }
  if (containsSecretPatterns(`${out.title}\n${out.body}\n${out.evidence}`)) {
    throw new MemoryError('secret',
      'This memory looks like it contains a credential (password, token, secret or API key). Nothing was saved. Remove sensitive information before saving a memory.');
  }
  return out;
}

function normalizeScope(scope) {
  const value = scope === undefined || scope === null || scope === '' ? 'project' : String(scope);
  if (value !== 'project' && value !== 'user') throw new MemoryError('invalid', 'scope must be "project" or "user".');
  return value;
}

function folderFor(scope, project) {
  if (scope === 'user') return USER_MEMORY_PREFIX.replace(/\/$/, '');
  if (!project?.key) throw new MemoryError('no_project', 'No project is open, so project memory is unavailable. Open a project first.');
  return projectMemoryFolder(project.key);
}

async function assertSupersedes(ids, project) {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String).map(s => s.trim()).filter(Boolean))] : [];
  if (!list.length) return [];
  const visible = new Set((await listMemories({ project })).map(page => page.id));
  const unknown = list.filter(id => !visible.has(id));
  if (unknown.length) {
    throw new MemoryError('not_found', `supersedes lists unknown memory id(s): ${unknown.join(', ')}. Use ids from memory_search.`);
  }
  return list;
}

async function assertNotDuplicate(fields, scope, project, { excludeId, deps }) {
  const entries = (await loadMemoryEntries(project, scope))
    .filter(entry => entry.meta.id !== excludeId);
  const wanted = normalizeTitle(fields.title);
  const sameTitle = entries.find(entry => normalizeTitle(entry.meta.title) === wanted);
  if (sameTitle) {
    throw new MemoryError('duplicate',
      `A ${scope} memory with this title already exists (id ${sameTitle.meta.id}). Read it with memory_read, then update it with id and expectedRevision instead of adding another.`,
      { conflictId: sameTitle.meta.id });
  }
  if (excludeId) return;
  const config = deps?.config ?? (await loadBrainConfig());
  // Re-embed for duplicate checks: background vector sync may not have finished
  // after the previous save/update, even though the record is already visible.
  const similarities = await memorySimilarities(`${fields.title}\n${fields.body}`, entries, config, { ...deps, fresh: true });
  if (!similarities) return;
  let best = null;
  for (const entry of entries) {
    const score = similarities.get(entry.meta.id) ?? 0;
    if (score >= DUPLICATE_MIN_COSINE && (!best || score > best.score)) best = { entry, score };
  }
  if (best) {
    throw new MemoryError('duplicate',
      `This overlaps an existing ${scope} memory "${best.entry.meta.title}" (id ${best.entry.meta.id}). Read it with memory_read and update it (id and expectedRevision) instead of adding a second one.`,
      { conflictId: best.entry.meta.id });
  }
}

/**
 * Create a memory in the project (default) or user scope.
 * @param {{ project: { key: string, label?: string } | null, scope?: string, title: string, body: string, kind: string, evidence?: string, supersedes?: string[], sourceChatId?: string, source?: string }} input
 * @param {object} [deps]
 */
export function createMemory(input, deps = {}) {
  return serial(async () => {
    deps.signal?.throwIfAborted();
    const scope = normalizeScope(input.scope);
    const fields = validateFields(input);
    const folder = folderFor(scope, input.project);
    const supersedes = await assertSupersedes(input.supersedes, input.project);
    await assertNotDuplicate(fields, scope, input.project, { deps });
    const id = randomUUID();
    const relPath = `${folder}/${slugFor(fields.title, id)}.md`;
    deps.signal?.throwIfAborted();
    const page = await createPage({
      relPath,
      id,
      title: fields.title,
      body: fields.body,
      tags: [],
      summary: summarize(fields.body),
      source: input.source === 'user' ? 'user' : 'agent',
      kind: fields.kind,
      scope,
      evidence: fields.evidence,
      supersedes,
      sourceChatId: input.sourceChatId ? String(input.sourceChatId) : undefined,
      ...(scope === 'project' ? { projectKey: input.project.key, projectLabel: input.project.label ?? '' } : {}),
    });
    return { ...page, scope };
  });
}

/**
 * Update a memory; requires the revision from memory_read.
 * @param {{ project: object | null, id: string, expectedRevision: string, title?: string, body?: string, kind?: string, evidence?: string, supersedes?: string[], scope?: string, source?: string }} input
 */
export function updateMemory(input, deps = {}) {
  return serial(async () => {
    deps.signal?.throwIfAborted();
    const current = await readMemory(input.id, { project: input.project });
    const expected = String(input.expectedRevision ?? '').trim();
    if (!expected) {
      throw new MemoryError('revision_required', `expectedRevision is required to update ${current.meta.id}. Read it with memory_read first.`);
    }
    if (expected !== current.revision) {
      throw new MemoryError('stale', `Memory ${current.meta.id} changed since you read it. Read it again with memory_read and reapply your change.`);
    }
    if (input.scope !== undefined && input.scope !== null && input.scope !== '' && normalizeScope(input.scope) !== current.scope) {
      throw new MemoryError('invalid', `Memory ${current.meta.id} is a ${current.scope} memory; scope cannot change. Forget it and save a new one in the other scope.`);
    }
    const fields = validateFields({
      title: input.title ?? current.meta.title,
      body: input.body ?? current.body,
      kind: input.kind ?? current.meta.kind ?? 'reference',
      evidence: input.evidence ?? current.meta.evidence ?? '',
    });
    const supersedes = input.supersedes !== undefined
      ? (await assertSupersedes(input.supersedes, input.project)).filter(id => id !== current.meta.id)
      : undefined;
    await assertNotDuplicate(fields, current.scope, input.project, { excludeId: current.meta.id, deps });
    deps.signal?.throwIfAborted();
    const page = await updatePage(current.path, {
      expectedRevision: current.revision,
      title: fields.title,
      body: fields.body,
      summary: summarize(fields.body),
      kind: fields.kind,
      evidence: fields.evidence,
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(input.source === 'user' ? { source: 'user' } : {}),
    }).catch(error => {
      if (error?.statusCode === 409) {
        throw new MemoryError('stale', `Memory ${current.meta.id} changed since you read it. Read it again with memory_read.`);
      }
      throw error;
    });
    return { ...page, scope: current.scope };
  });
}

/** Delete a memory, keeping a `.bak` copy of its last content beside the page. */
export function forgetMemory({ project, id, expectedRevision, signal } = {}) {
  return serial(async () => {
    signal?.throwIfAborted();
    const current = await readMemory(id, { project });
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new MemoryError('stale', `Memory ${current.meta.id} changed since it was loaded. Reload and try again.`);
    }
    const abs = await resolvePagePath(current.path);
    await fs.copyFile(abs, `${abs}.bak`);
    signal?.throwIfAborted();
    await deletePage(current.path, { expectedRevision: current.revision });
    return { id: current.meta.id, title: current.meta.title, scope: current.scope, path: current.path };
  });
}

/**
 * Move one project's memories to a new key after its repository moved
 * (project-move flow). Idempotent: already-moved pages are skipped.
 * @param {string} fromKey
 * @param {{ key: string, label?: string }} to
 */
export function rebindProjectMemories(fromKey, to) {
  return serial(async () => {
    if (!fromKey || !to?.key || fromKey === to.key) return 0;
    const prefix = `${projectMemoryFolder(fromKey)}/`;
    const targetPrefix = `${projectMemoryFolder(to.key)}/`;
    // A crash can leave the catalog behind the physical rename. Repair it first.
    await rebuildCatalog();
    const pages = await listPages();
    const rows = pages.filter(page => page.path.startsWith(prefix) && memoryScopeOfPath(page.path));
    // Refuse collisions before moving anything; never overwrite another memory.
    for (const row of rows) {
      const target = `${targetPrefix}${row.path.slice(prefix.length)}`;
      if (pages.some(page => page.path === target)) throw new MemoryError('conflict', `Cannot move memory ${row.id}: ${target} already exists.`);
    }
    let moved = 0;
    for (const row of rows) {
      // Rename keeps the page id, history backup and vector; then restamp its project fields.
      const target = `${projectMemoryFolder(to.key)}/${row.path.slice(prefix.length)}`;
      const from = await resolvePagePath(row.path);
      const dest = await resolvePagePath(target);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(from, dest);
      await fs.rename(`${from}.bak`, `${dest}.bak`).catch(() => {});
      await rebuildCatalog();
      await updatePage(target, { projectKey: to.key, projectLabel: to.label ?? '', skipAnchorSync: true });
      moved += 1;
    }
    // Resume a crash between rename and restamping the frontmatter.
    for (const page of pages) {
      if (page.path.startsWith(targetPrefix) && page.projectKey === fromKey) {
        await updatePage(page.path, { projectKey: to.key, projectLabel: to.label ?? '', skipAnchorSync: true });
      }
    }
    await fs.rmdir(path.dirname(await resolvePagePath(`${prefix}x.md`))).catch(() => {});
    return moved;
  });
}
