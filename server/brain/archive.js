/**
 * Brain-backed chat archive — bundle stale turns into wiki pages (MIN-139).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { llmCall } from '../research/llm.js';
import { loadSynthesisConfig, resolveSynthesisModel } from './synthesis-config.js';
import { parseExtractionJson } from './synthesis.js';
import {
  appendLog,
  createPage,
  deletePage,
  listPages,
  loadBrainConfig,
  readPage,
  rebuildCatalog,
  updatePage,
} from './store.js';
import { getBrainPagesDir, resolvePagePath, scopedBrainPagePath } from './paths.js';
import { resolveLegacyOwners } from './workspace-ownership.js';
import { createVectorStore, cosineSimilarity } from '../engine/vector-store.js';
import { getEnginePaths } from './engine-paths.js';
import { isValidPageId } from './paths.js';
import { syncEntryVector } from './vector-sync.js';

const vectorStore = createVectorStore(getEnginePaths, { isValidEntryId: isValidPageId });
const { getEntryVector, loadVectorStore } = vectorStore;

const ARCHIVE_BUNDLE_PROMPT = `You compress a span of chat turns into structured wiki knowledge for later retrieval.

Return a JSON object with:
- "title": short page title for this turn range
- "facts": array of { "statement", "sourceQuote", "sourceTurnIndex" } — each fact MUST quote an exact verbatim substring of one input turn
- "entities": array of { "slug", "title", "kind" } where kind is file|ticket|concept
- "body": optional extra markdown (wikilinks like [[entities/slug]] encouraged)

Omit facts you cannot anchor to a verbatim quote. Return ONLY valid JSON.`;

/** Extract plain text from a bundled API message shape. */
function messageText(turn) {
  const role = turn?.role;
  const content = turn?.content;
  if (role === 'tool') return String(content ?? '');
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === 'object' && p.type === 'text')
      .map((p) => String(p.text ?? ''))
      .join('\n');
  }
  return '';
}

/**
 * Relative path prefix for a chat archive folder.
 * @param {string} workspaceKey
 * @param {string} chatId
 */
export function archiveFolderPrefix(workspaceKey, chatId) {
  const key = String(workspaceKey ?? '').trim() || 'workspace';
  const id = String(chatId ?? '').trim();
  return `workspaces/${key}/archive/${id}`;
}

/**
 * Stable slug for a bundled turn range.
 * @param {number[]} sourceTurnIndices
 */
export function archiveRangeSlug(sourceTurnIndices) {
  const sorted = [...sourceTurnIndices].sort((a, b) => a - b);
  const first = sorted[0] ?? 0;
  const last = sorted[sorted.length - 1] ?? first;
  const pad = (n) => String(n).padStart(4, '0');
  return `turns-${pad(first)}-${pad(last)}`;
}

/**
 * @param {object} front
 */
function parseFrontmatterIndices(front) {
  const raw = front?.sourceTurnIndices;
  if (Array.isArray(raw)) {
    return raw.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  }
  return [];
}

/**
 * @param {object[]} turns
 * @param {number} historyIndex
 */
function serializeTurnForBundle(turn, historyIndex) {
  const role = turn.role;
  const text = messageText(turn);
  return `--- turn ${historyIndex} (${role}) ---\n${text}`;
}

/**
 * Deterministic bundler when LLM is unavailable (tests + fallback).
 * @param {object[]} turns
 * @param {number[]} sourceTurnIndices
 */
export function buildExtractiveArchiveBundle(turns, sourceTurnIndices) {
  const facts = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    const histIdx = sourceTurnIndices[i] ?? i;
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    const text = messageText(turn).trim();
    if (!text) continue;
    const quote = text.length > 240 ? text.slice(0, 240) : text;
    facts.push({
      statement: text.slice(0, 500),
      sourceQuote: quote,
      sourceTurnIndex: histIdx,
    });
  }
  const first = sourceTurnIndices[0] ?? 0;
  const last = sourceTurnIndices[sourceTurnIndices.length - 1] ?? first;
  return {
    title: `Archived turns ${first}-${last}`,
    facts,
    entities: [],
    body: '',
  };
}

/**
 * @param {object} bundle
 * @param {object[]} turns
 * @param {number[]} sourceTurnIndices
 */
export function validateArchiveBundleServer(bundle, turns, sourceTurnIndices) {
  const errors = [];
  const textByIndex = new Map();
  for (let i = 0; i < turns.length; i += 1) {
    const histIdx = sourceTurnIndices[i] ?? i;
    textByIndex.set(histIdx, messageText(turns[i]));
  }
  const validFacts = [];
  for (const fact of bundle.facts ?? []) {
    const quote = String(fact.sourceQuote ?? '').trim();
    const statement = String(fact.statement ?? '').trim();
    const turnIdx = Number(fact.sourceTurnIndex);
    if (!quote || !statement) {
      errors.push('missing statement or quote');
      continue;
    }
    const source = textByIndex.get(turnIdx) ?? '';
    if (!source.includes(quote)) {
      errors.push(`quote not in turn ${turnIdx}`);
      continue;
    }
    validFacts.push({ statement, sourceQuote: quote, sourceTurnIndex: turnIdx });
  }
  if (validFacts.length === 0) errors.push('zero anchored facts');
  return { ok: errors.length === 0, facts: validFacts, errors };
}

/**
 * @param {{ facts: object[], entities: object[], body?: string, title: string }} bundle
 */
function renderArchivePageBody(bundle) {
  const lines = ['## Facts'];
  for (const fact of bundle.facts) {
    lines.push(`### ${fact.statement}`);
    lines.push(`> ${fact.sourceQuote}`);
    lines.push(`<!-- sourceTurnIndex: ${fact.sourceTurnIndex} -->`);
    lines.push('');
  }
  if (bundle.entities?.length) {
    lines.push('## Entities');
    for (const ent of bundle.entities) {
      const slug = String(ent.slug ?? '').trim();
      if (!slug) continue;
      lines.push(`- [[entities/${slug}]] — ${String(ent.title ?? slug)}`);
    }
    lines.push('');
  }
  if (bundle.body?.trim()) {
    lines.push(bundle.body.trim());
  }
  return lines.join('\n').trim();
}

/**
 * @param {object} raw
 */
function parseArchiveBundleJson(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      const rows = parseExtractionJson(raw);
      parsed = rows[0] ?? {};
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (parsed);
  return {
    title: String(r.title ?? 'Archived turns'),
    facts: Array.isArray(r.facts) ? r.facts : [],
    entities: Array.isArray(r.entities) ? r.entities : [],
    body: String(r.body ?? ''),
  };
}

const ARCHIVE_RETRY_APPEND =
  '\n\nPrevious output had invalid quotes. Return fewer facts; every sourceQuote MUST be copied verbatim from the transcript.';

/**
 * Run LLM bundle with optional stricter retry when quote validation fails.
 * @param {object[]} turns
 * @param {number[]} sourceTurnIndices
 * @param {boolean} extractiveOnly
 */
async function buildBundleWithRetry(turns, sourceTurnIndices, extractiveOnly) {
  if (extractiveOnly) {
    const bundle = buildExtractiveArchiveBundle(turns, sourceTurnIndices);
    const validated = validateArchiveBundleServer(bundle, turns, sourceTurnIndices);
    return { bundle, validated };
  }

  const cfg = await loadSynthesisConfig();
  const modelBinding = await resolveSynthesisModel(cfg);
  const transcript = turns
    .map((t, i) => serializeTurnForBundle(t, sourceTurnIndices[i] ?? i))
    .join('\n\n');

  const attemptBundle = async (strict) => {
    if (!modelBinding?.providerId || !modelBinding?.model) return null;
    try {
      const llmRaw = await llmCall({
        providerId: modelBinding.providerId,
        model: modelBinding.model,
        messages: [
          {
            role: 'system',
            content: strict ? `${ARCHIVE_BUNDLE_PROMPT}${ARCHIVE_RETRY_APPEND}` : ARCHIVE_BUNDLE_PROMPT,
          },
          { role: 'user', content: transcript.slice(0, 48_000) },
        ],
        temperature: 0.2,
        maxTokens: 4096,
        timeoutMs: 60_000,
      });
      return parseArchiveBundleJson(llmRaw);
    } catch {
      return null;
    }
  };

  let bundle = await attemptBundle(false);
  let validated = bundle
    ? validateArchiveBundleServer(bundle, turns, sourceTurnIndices)
    : { ok: false, facts: [], errors: ['no bundle'] };

  if (!validated.ok) {
    await appendLog('archive bundle validation failed — retrying with stricter prompt');
    const retryBundle = await attemptBundle(true);
    if (retryBundle) {
      bundle = retryBundle;
      validated = validateArchiveBundleServer(bundle, turns, sourceTurnIndices);
    }
  }

  if (!bundle || !validated.ok) {
    bundle = buildExtractiveArchiveBundle(turns, sourceTurnIndices);
    validated = validateArchiveBundleServer(bundle, turns, sourceTurnIndices);
  }

  return { bundle, validated };
}

/** Link new archive page to similar neighbors via frontmatter similarTo. */
async function attachSimilarArchiveLinks(workspaceKey, chatId, page, body) {
  const brainConfig = await loadBrainConfig();
  if (brainConfig.embeddings?.enabled !== true) return;

  try {
    await syncEntryVector(page.meta, body, brainConfig);
    const store = await loadVectorStore();
    const newVector =
      store.vectors[page.meta.id] ?? (await getEntryVector(page.meta.id));
    if (!newVector?.length) return;

    const prefix = archiveFolderPrefix(workspaceKey, chatId);
    const pages = await resolveLegacyOwners(await listPages());
    const neighbors = [];
    for (const other of pages) {
      if (other.path === page.meta.path) continue;
      if (!scopedBrainPagePath(other).startsWith(`${prefix}/`) || !other.path.includes('turns-')) continue;
      const vec = store.vectors[other.id] ?? (await getEntryVector(other.id));
      if (!vec?.length) continue;
      const score = cosineSimilarity(newVector, vec);
      if (score >= 0.82) neighbors.push({ path: other.path, score });
    }
    neighbors.sort((a, b) => b.score - a.score);
    const similarTo = neighbors.slice(0, 5).map((n) => n.path);
    if (similarTo.length) {
      await updatePage(page.meta.path, { similarTo });
    }
  } catch {
    /* similarity is best-effort */
  }
}

/**
 * Promote recurring entity slugs to workspace concepts/ after 2+ chats.
 * @param {string} workspaceKey
 * @param {string} slug
 * @param {string} chatId
 * @param {{ title?: string, kind?: string }} ent
 */
export async function maybePromoteEntity(workspaceKey, slug, chatId, ent) {
  const key = String(workspaceKey ?? '').trim() || 'workspace';
  const entitySlug = String(slug ?? '').trim();
  if (!entitySlug) return;

  const pages = await resolveLegacyOwners(await listPages());
  const archivePrefix = `workspaces/${key}/archive/`;
  const matches = pages.filter(
    (p) =>
      scopedBrainPagePath(p).startsWith(archivePrefix) &&
      p.path.endsWith(`/entities/${entitySlug}.md`),
  );
  const chatIds = new Set(matches.map((p) => {
    const m = p.path.match(/\/archive\/([^/]+)\//);
    return m ? m[1] : '';
  }).filter(Boolean));
  chatIds.add(chatId);
  if (chatIds.size < 2) return;

  const conceptPath = `workspaces/${key}/concepts/${entitySlug}.md`;
  const promotedFrom = [...chatIds];
  const body = `# ${String(ent.title ?? entitySlug)}\n\nKind: ${String(ent.kind ?? 'concept')}\n\nPromoted from chats: ${promotedFrom.join(', ')}`;
  try {
    await createPage({
      relPath: conceptPath,
      title: String(ent.title ?? entitySlug),
      body,
      tags: ['concept', 'archive-promoted'],
      source: 'archive',
      summary: `Promoted concept (${promotedFrom.length} chats)`,
    });
  } catch (e) {
    if (e && typeof e === 'object' && 'statusCode' in e && e.statusCode === 409) {
      await updatePage(conceptPath, { title: String(ent.title ?? entitySlug), body });
    }
  }

  for (const match of matches) {
    const linkBody = `# ${String(ent.title ?? entitySlug)}\n\nSee [[../../concepts/${entitySlug}]]`;
    try {
      await updatePage(match.path, { body: linkBody });
    } catch {
      /* skip */
    }
  }
}

/** Create rollup index when a chat has 3+ turn bundles and no rollup yet. */
export async function maybeCreateArchiveRollup(workspaceKey, chatId) {
  const prefix = archiveFolderPrefix(workspaceKey, chatId);
  const pages = await resolveLegacyOwners(await listPages());
  const turnPages = pages
    .filter((p) => scopedBrainPagePath(p).startsWith(`${prefix}/`) && p.path.includes('turns-'))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (turnPages.length < 3) return;

  const rollupPath = `${prefix}/index.md`;
  if (pages.some((p) => p.path === rollupPath)) return;

  const links = turnPages
    .map((p) => `- [[${p.path.replace(/\.md$/i, '')}]] — ${p.title}`)
    .join('\n');
  const body = `## Archived turn bundles\n\n${links}`;
  await createPage({
    relPath: rollupPath,
    title: 'Chat archive summary',
    body,
    tags: ['archive', 'archive-rollup', `chat:${chatId}`],
    source: 'archive',
    summary: `Rollup for ${turnPages.length} archived spans`,
    chatId,
  });
}

/**
 * @param {{ chatId: string, workspaceKey: string, turns: object[], sourceTurnIndices: number[], extractiveOnly?: boolean }} input
 */
export async function bundleArchiveRange(input) {
  const chatId = String(input.chatId ?? '').trim();
  const workspaceKey = String(input.workspaceKey ?? '').trim() || 'workspace';
  const turns = Array.isArray(input.turns) ? input.turns : [];
  const sourceTurnIndices = Array.isArray(input.sourceTurnIndices)
    ? input.sourceTurnIndices.map((n) => Number(n))
    : [];

  if (!chatId || turns.length === 0 || sourceTurnIndices.length === 0) {
    const err = new Error('chatId, turns, and sourceTurnIndices are required');
    err.statusCode = 400;
    throw err;
  }

  const { bundle, validated } = await buildBundleWithRetry(
    turns,
    sourceTurnIndices,
    input.extractiveOnly === true,
  );
  if (!validated.ok) {
    const err = new Error(`Archive bundle validation failed: ${validated.errors.join('; ')}`);
    err.statusCode = 422;
    throw err;
  }

  const prefix = archiveFolderPrefix(workspaceKey, chatId);
  const slug = archiveRangeSlug(sourceTurnIndices);
  const relPath = `${prefix}/${slug}.md`;
  const body = renderArchivePageBody({ ...bundle, facts: validated.facts });

  let page;
  try {
    page = await createPage({
      relPath,
      title: bundle.title,
      body,
      tags: ['archive', `chat:${chatId}`],
      source: 'archive',
      summary: `Archived chat turns ${sourceTurnIndices[0]}-${sourceTurnIndices[sourceTurnIndices.length - 1]}`,
      chatId,
      sourceTurnIndices,
    });
  } catch (e) {
    if (e && typeof e === 'object' && 'statusCode' in e && e.statusCode === 409) {
      page = await updatePage(relPath, {
        title: bundle.title,
        body,
        tags: ['archive', `chat:${chatId}`],
        summary: `Archived chat turns ${sourceTurnIndices[0]}-${sourceTurnIndices[sourceTurnIndices.length - 1]}`,
      });
    } else {
      throw e;
    }
  }

  for (const ent of bundle.entities ?? []) {
    const entSlug = String(ent.slug ?? '').trim();
    if (!entSlug) continue;
    const entPath = `${prefix}/entities/${entSlug}.md`;
    const entBody = `# ${String(ent.title ?? entSlug)}\n\nKind: ${String(ent.kind ?? 'concept')}`;
    try {
      await createPage({
        relPath: entPath,
        title: String(ent.title ?? entSlug),
        body: entBody,
        tags: ['archive-entity', `chat:${chatId}`],
        source: 'archive',
        chatId,
      });
    } catch {
      /* entity page may already exist */
    }
    await maybePromoteEntity(workspaceKey, entSlug, chatId, ent);
  }

  await attachSimilarArchiveLinks(workspaceKey, chatId, page, body);
  await maybeCreateArchiveRollup(workspaceKey, chatId);

  await appendLog(`archive bundled ${relPath} for chat ${chatId}`);
  return {
    pageIds: [page.meta.id],
    ranges: [
      {
        startIndex: sourceTurnIndices[0],
        endIndex: (sourceTurnIndices[sourceTurnIndices.length - 1] ?? 0) + 1,
        sourceTurnIndices,
        pagePath: relPath,
      },
    ],
  };
}

/**
 * @param {string} chatId
 * @param {string} workspaceKey
 * @param {object[]} [pending]
 */
export async function getArchiveStatus(chatId, workspaceKey, pending = []) {
  const prefix = archiveFolderPrefix(workspaceKey, chatId);
  const pages = await resolveLegacyOwners(await listPages());
  const archivePages = pages.filter(
    (p) => scopedBrainPagePath(p).startsWith(`${prefix}/`) && p.path.includes('turns-'),
  );

  const ranges = [];
  for (const page of archivePages) {
    try {
      const row = await readPage(page.path);
      const indices = parseFrontmatterIndices(row.meta);
      if (indices.length === 0) continue;
      const sorted = [...indices].sort((a, b) => a - b);
      ranges.push({
        startIndex: sorted[0],
        endIndex: sorted[sorted.length - 1] + 1,
        sourceTurnIndices: indices,
        pagePath: page.path,
      });
    } catch {
      /* skip corrupt page */
    }
  }

  const readyKeys = new Set(ranges.map((r) => `${r.startIndex}-${r.endIndex}`));
  const stillPending = (pending ?? []).filter(
    (r) => !readyKeys.has(`${r.startIndex}-${r.endIndex}`),
  );

  return { chatId, ranges, pending: stillPending };
}

/**
 * @param {string} chatId
 * @param {string} workspaceKey
 */
export async function deleteChatArchive(chatId, workspaceKey) {
  const prefix = archiveFolderPrefix(workspaceKey, chatId);
  const pages = await resolveLegacyOwners(await listPages());
  const victims = pages.filter(page => scopedBrainPagePath(page).startsWith(prefix + '/'));
  const dirs = new Set();
  let removed = 0;
  for (const page of victims) {
    // Only remove cataloged pages owned by this workspace. Assigned pages can
    // occupy a shared legacy directory and still have working original links.
    const abs = await resolvePagePath(page.path);
    const latest = await readPage(page.path);
    const [owner] = await resolveLegacyOwners([latest.meta]);
    if (!scopedBrainPagePath(owner).startsWith(prefix + '/')) continue;
    await deletePage(page.path, { expectedRevision: latest.revision, removeBackup: true });
    removed += 1;
    const physicalPrefix = page.path.split('/').slice(0, 4).join('/');
    const archiveDir = path.dirname(await resolvePagePath(physicalPrefix + '/placeholder.md'));
    for (let dir = path.dirname(abs); dir === archiveDir || dir.startsWith(archiveDir + path.sep); dir = path.dirname(dir)) dirs.add(dir);
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await fs.rmdir(dir).catch(err => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err; });
  }
  await appendLog(`deleted archive folder for chat ${chatId}`);
  return { ok: true, removed };
}

/**
 * Remove archive folders whose chatId is not in liveChatIds (startup sweep).
 * @param {Set<string>} liveChatIds
 */
export async function reconcileOrphanArchives(liveChatIds) {
  if (!liveChatIds || liveChatIds.size === 0) return { swept: 0 };
  const pagesDir = getBrainPagesDir();
  const archiveRoot = path.join(pagesDir, 'workspaces');
  let swept = 0;

  let workspaceDirs = [];
  try {
    workspaceDirs = await fs.readdir(archiveRoot, { withFileTypes: true });
  } catch {
    return { swept: 0 };
  }

  const assignedArchives = new Set((await listPages()).filter(page => page.assignedWorkspace)
    .map(page => page.path.split('/').slice(0, 4).join('/')));
  for (const ws of workspaceDirs) {
    // Older basename folders may contain multiple checkouts' notes, including
    // archives whose conversation has already been removed. Keep them for review.
    if (!ws.isDirectory() || !/--[a-f0-9]{32}$/.test(ws.name)) continue;
    const archiveDir = path.join(archiveRoot, ws.name, 'archive');
    let chatDirs = [];
    try {
      chatDirs = await fs.readdir(archiveDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const chat of chatDirs) {
      if (!chat.isDirectory()) continue;
      if (liveChatIds.has(chat.name) || assignedArchives.has('workspaces/' + ws.name + '/archive/' + chat.name)) continue;
      await fs.rm(path.join(archiveDir, chat.name), { recursive: true, force: true });
      swept += 1;
    }
  }

  if (swept > 0) {
    await rebuildCatalog();
  }

  return { swept };
}
