import { llmCall } from '../research/llm.js';
import { containsSecretPatterns } from './secret-patterns.js';
import { loadAllPagesWithBodies } from './retrieve.js';
import { createPage, loadBrainConfig, updatePage } from './store.js';
import { loadSynthesisConfig, resolveSynthesisModel } from './synthesis-config.js';
import { addMemoryProposal } from './proposals.js';
import { DEFAULT_LINKING_CONFIG, normalizeLinkingConfig } from './linking-config.js';
import { brainWorkspaceKeyFromPath } from './paths.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { recordBrainUsage } from './usage.js';
import { getEmbedder, embedTexts } from '../engine/embeddings.js';
import {
  cosineSimilarity,
  getEntryVector,
  isVectorStoreCompatible,
  loadVectorStore,
} from './vector-store.js';

// ── Extract ──────────────────────────────────────────────────────────────────

export const CONTEXT_WINDOW = 6;

export const EXTRACT_SYSTEM_PROMPT = `You are a knowledge extraction assistant. Analyze the conversation and extract ONLY durable knowledge worth recalling in future sessions. There are two tracks — extract from either or both.

PERSONAL track (scope: "personal") — durable facts about the user.
Good: name, job title, city, family, long-term projects, strong tooling preferences.
Bad: what they asked about today, temporary moods, one-off tasks, opinions on the current topic.

PROJECT track (scope: "workspace") — durable knowledge about the codebase or system being worked on.
Good:
- A decision and WHY it was made, including alternatives that were rejected.
- A root cause that took real digging: symptom, underlying cause, and the fix.
- A convention this project follows that isn't obvious from a single file.
- An environment quirk (a flag that must go in a specific position, a tool that hangs without an option, a port that must be pinned).
- An approach that was TRIED AND FAILED, so it isn't retried.
- A key reference: where the authoritative config, schema, or entry point lives.
Bad: restating what the code plainly says, narration of routine edits, anything not verified during THIS session, speculation about what might work.

Rules:
- MAX 3 items total across both tracks — only the most valuable
- PERSONAL items must be stated or clearly implied by the USER
- PROJECT items must be verified in this session — a fix that actually worked, an error actually observed. If it was only proposed, skip it.
- Each item needs a specific, searchable title (name the thing: file, tool, error, feature) and a body of 1-3 concrete sentences
- If an item is likely already known, skip it
- If nothing durable came up, return []
- Never include passwords, API keys, tokens, or other secrets
- confidence reflects how sure you are the item is durable and correct — hedge below 0.85 if it was inferred rather than confirmed

Return a JSON array of objects with fields: title, body, tags (string array), category, scope, confidence (0-1), rationale.
Categories: identity, preference, fact, contact, project, goal, decision, gotcha, convention, environment, reference.
Scope: "personal" or "workspace".

Return ONLY valid JSON, no markdown fences.`;

export { containsSecretPatterns };

/**
 * @param {string} raw
 * @returns {unknown[]}
 */
export function parseExtractionJson(raw) {
  if (!raw || typeof raw !== 'string') return [];

  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.split('\n', 1)[0] === '```json'
      ? s.slice(s.indexOf('\n') + 1)
      : s.slice(3);
    const close = s.lastIndexOf('```');
    if (close >= 0) s = s.slice(0, close).trim();
  }

  const tryParse = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(s);
  if (direct) return direct;

  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const slice = tryParse(s.slice(start, end + 1));
    if (slice) return slice;
  }

  return [];
}

export const PERSONAL_CATEGORIES = new Set([
  'identity',
  'preference',
  'fact',
  'contact',
  'project',
  'goal',
]);

export const PROJECT_CATEGORIES = new Set([
  'decision',
  'gotcha',
  'convention',
  'environment',
  'reference',
]);

export const FACT_BODY_MAX_CHARS = 400;

// ── Facts ────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} row
 * @returns {object | null}
 */
export function normalizeExtractedFact(row) {
  if (!row || typeof row !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  const title = String(r.title ?? r.text ?? '').trim();
  const body = String(r.body ?? r.text ?? '').trim();
  if (!title && !body) return null;
  const combined = `${title}\n${body}`;
  if (containsSecretPatterns(combined)) return null;

  const category = String(r.category ?? 'fact').toLowerCase();
  const validCategory = PERSONAL_CATEGORIES.has(category) || PROJECT_CATEGORIES.has(category)
    ? category
    : 'fact';

  const rawScope = String(r.scope ?? '').toLowerCase();
  const scope =
    rawScope === 'personal' || rawScope === 'workspace'
      ? rawScope
      : PROJECT_CATEGORIES.has(validCategory)
        ? 'workspace'
        : 'personal';

  let confidence = 0.7;
  if (typeof r.confidence === 'number' && Number.isFinite(r.confidence)) {
    confidence = Math.min(1, Math.max(0, r.confidence));
  }

  const tags = Array.isArray(r.tags)
    ? r.tags.map((t) => String(t).trim()).filter(Boolean)
    : [];

  return {
    title: title || body.slice(0, 80),
    body: (body || title).slice(0, FACT_BODY_MAX_CHARS),
    tags,
    category: validCategory,
    scope,
    confidence,
    rationale: String(r.rationale ?? '').slice(0, 500),
  };
}

export function slugifyFactTitle(title) {
  const slug = String(title ?? 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'untitled';
}

export const VECTOR_DUPLICATE_THRESHOLD = 0.92;

// ── Duplicates ───────────────────────────────────────────────────────────────

/**
 * @param {string} title
 * @param {string} body
 * @param {Array<{ meta: object, body: string }>} existing
 * @param {object} brainConfig
 * @param {{ getEmbedder?: typeof getEmbedder, embedTexts?: typeof embedTexts, loadVectorStore?: typeof loadVectorStore, getEntryVector?: typeof getEntryVector }} [deps]
 * @returns {Promise<boolean>}
 */
export async function isDuplicateMemory(title, body, existing, brainConfig, deps = {}) {
  const query = `${title} ${body}`.trim();
  if (!query) return true;

  const emb = brainConfig.embeddings ?? {};
  if (emb.enabled && existing.length > 0) {
    try {
      const embedder = await (deps.getEmbedder ?? getEmbedder)(brainConfig);
      const store = await (deps.loadVectorStore ?? loadVectorStore)();
      if (
        isVectorStoreCompatible(store, {
          modelId: embedder.id,
          backend: emb.backend,
          dim: embedder.dim,
        })
      ) {
        const [queryVector] = await (deps.embedTexts ?? embedTexts)(
          embedder,
          [query],
          emb.queryTimeoutMs,
        );
        if (queryVector) {
          for (const row of existing) {
            const stored =
              store.vectors[row.meta.id] ??
              (await (deps.getEntryVector ?? getEntryVector)(row.meta.id));
            if (
              stored &&
              cosineSimilarity(queryVector, stored) >= VECTOR_DUPLICATE_THRESHOLD
            ) {
              return true;
            }
          }
        }
      }
    } catch {
    }
  }

  const needle = query.toLowerCase();
  for (const row of existing) {
    const hay = `${row.meta.title ?? ''} ${row.body ?? ''}`.toLowerCase();
    if (hay.includes(needle) || needle.includes(hay.slice(0, 80))) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} query
 * @param {Array<{ meta: object, body: string }>} existing
 * @param {object} brainConfig
 * @param {{ getEmbedder?: typeof getEmbedder, embedTexts?: typeof embedTexts, loadVectorStore?: typeof loadVectorStore, getEntryVector?: typeof getEntryVector }} [deps]
 * @returns {Promise<Map<string, number>>}
 */
export async function scorePagesByCosine(query, existing, brainConfig, deps = {}) {
  /** @type {Map<string, number>} */
  const scores = new Map();
  const text = String(query ?? '').trim();
  if (!text || !Array.isArray(existing) || existing.length === 0) return scores;

  const emb = brainConfig?.embeddings ?? {};
  if (!emb.enabled) return scores;

  try {
    const embedder = await (deps.getEmbedder ?? getEmbedder)(brainConfig);
    const store = await (deps.loadVectorStore ?? loadVectorStore)();
    if (
      !isVectorStoreCompatible(store, {
        modelId: embedder.id,
        backend: emb.backend,
        dim: embedder.dim,
      })
    ) {
      return scores;
    }
    const [queryVector] = await (deps.embedTexts ?? embedTexts)(
      embedder,
      [text],
      emb.queryTimeoutMs,
    );
    if (!queryVector) return scores;

    for (const row of existing) {
      const id = row?.meta?.id;
      if (!id) continue;
      const stored =
        store.vectors[id] ?? (await (deps.getEntryVector ?? getEntryVector)(id));
      if (!stored) continue;
      scores.set(id, cosineSimilarity(queryVector, stored));
    }
  } catch {
  }

  return scores;
}

/**
 * @param {object} brainConfig
 * @returns {typeof DEFAULT_LINKING_CONFIG}
 */
function linkingConfig(brainConfig) {
  return normalizeLinkingConfig(brainConfig?.linking);
}

/**
 * @param {Array<{ role?: string, content?: string | unknown[] }>} messages
 * @param {{ window?: number, perMessageChars?: number, roles?: string[] }} [opts]
 * @returns {string}
 */
export function formatMessagesForExtraction(messages, opts = {}) {
  const window = Math.max(1, opts.window ?? CONTEXT_WINDOW);
  const perMessageChars = Math.max(100, opts.perMessageChars ?? 500);
  const roles = Array.isArray(opts.roles) && opts.roles.length > 0 ? new Set(opts.roles) : null;

  const lines = [];
  for (const msg of messages.slice(-window)) {
    const role = String(msg.role ?? '?');
    if (roles && !roles.has(role)) continue;
    let content = msg.content;
    if (Array.isArray(content)) {
      content = content
        .filter((b) => b && typeof b === 'object' && /** @type {{ type?: string }} */ (b).type === 'text')
        .map((b) => String(/** @type {{ text?: string }} */ (b).text ?? ''))
        .join(' ');
    }
    let text = String(content ?? '').trim();
    if (text.length > perMessageChars) text = `${text.slice(0, perMessageChars)}...`;
    if (text) lines.push(`[${role}] ${text}`);
  }
  return lines.join('\n');
}

/**
 * @param {{ scope?: string }} fact
 * @returns {string}
 */
export function synthesisFactDir(fact) {
  if (fact?.scope !== 'workspace') return 'facts';
  try {
    const key = brainWorkspaceKeyFromPath(getEffectiveWorkspaceRoot());
    return key ? `workspaces/${key}` : 'facts';
  } catch {
    return 'facts';
  }
}

// ── Write pages ──────────────────────────────────────────────────────────────

/**
 * @param {{ title: string, body: string, tags: string[], category?: string, scope?: string }} fact
 * @param {string[]} [similarTo]
 * @param {{ dir?: string, source?: string }} [opts]
 */
export async function writeSynthesisFactPage(fact, similarTo = [], opts = {}) {
  const dir = opts.dir ?? synthesisFactDir(fact);
  const tags = fact.category
    ? [fact.category, ...(fact.tags ?? []).filter((t) => t !== fact.category)]
    : (fact.tags ?? []);

  const baseSlug = slugifyFactTitle(fact.title);
  let slug = baseSlug;
  let n = 2;
  while (n < 50) {
    const relPath = `${dir}/${slug}.md`;
    try {
      const created = await createPage({
        relPath,
        title: fact.title,
        body: fact.body,
        tags,
        source: opts.source ?? 'synthesis',
        ...(similarTo.length > 0 ? { similarTo } : {}),
      });
      void recordBrainUsage(
        opts.source === 'agent' ? 'proposal-accepted' : 'synthesis-write',
      );
      return { page: created, relPath };
    } catch (err) {
      const status = err && typeof err === 'object' && 'statusCode' in err ? err.statusCode : null;
      if (status !== 409) throw err;
      slug = `${baseSlug}-${n}`;
      n += 1;
    }
  }
  throw new Error('Could not allocate a unique fact page path');
}

export const TITLE_STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'in', 'on', 'at', 'to',
  'for', 'and', 'or', 'but', 'with', 'by', 'from', 'user', 'has', 'have',
  'had', 'be', 'been', 'being', 'uses', 'use', 'used', 'my', 'me', 'our',
  'your', 'his', 'her', 'their', 'its', 'this', 'that', 'they', 'it', 'who',
  'what', 'when', 'where', 'will', 'would', 'could', 'should', 'may', 'not',
  'no', 'so', 'as', 'if', 'he', 'she', 'we', 'you',
]);

export function titleKeywords(title) {
  return new Set(
    String(title ?? '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !TITLE_STOP.has(w)),
  );
}

function sharedKeywordCount(kA, kB) {
  let shared = 0;
  for (const k of kA) if (kB.has(k)) shared++;
  return shared;
}

/**
 * @param {string} titleA
 * @param {string} titleB
 * @returns {boolean}
 */
export function titlesAreSameTopic(titleA, titleB) {
  const kA = titleKeywords(titleA);
  const kB = titleKeywords(titleB);
  if (kA.size === 0 || kB.size === 0) return false;
  const shared = sharedKeywordCount(kA, kB);
  const smaller = Math.min(kA.size, kB.size);
  const minShared = Math.min(2, smaller);
  return shared >= minShared && shared / smaller >= 0.5;
}

/**
 * @param {{ title: string, body: string, category?: string }} newFact
 * @param {string} newRelPath
 * @param {Array<{ meta: object, body: string }>} existing
 * @param {object} brainConfig
 * @param {object} [deps]
 */
export async function retireSupersededPages(
  newFact,
  newRelPath,
  existing,
  brainConfig,
  deps = {},
) {
  if (!newFact.title || !newRelPath) return;

  const { retireMinCosine } = linkingConfig(brainConfig);
  /** @type {Map<string, string>} page id → why it was retired */
  const reasons = new Map();

  for (const row of existing) {
    if (!row.meta?.id) continue;
    if (titlesAreSameTopic(newFact.title, row.meta.title)) {
      reasons.set(row.meta.id, 'same-topic-title');
    }
  }

  const cosines = await scorePagesByCosine(
    `${newFact.title} ${newFact.body}`.trim(),
    existing,
    brainConfig,
    deps,
  );
  for (const [id, score] of cosines) {
    if (score >= retireMinCosine && !reasons.has(id)) {
      reasons.set(id, `cosine=${score.toFixed(3)}`);
    }
  }

  for (const row of existing) {
    const reason = reasons.get(row.meta?.id);
    if (!reason) continue;
    const relPath = row.meta.path ?? '';
    if (!relPath || relPath === newRelPath) continue;
    if (row.meta.status === 'stale') continue;
    try {
      await updatePage(relPath, { status: 'stale', similarTo: [newRelPath] });
      console.info(
        `[brain] retired ${relPath} superseded by ${newRelPath} (${reason})`,
      );
    } catch {
    }
  }
}

/**
 * @param {{ title: string, body: string }} fact
 * @param {Array<{ meta: object, body: string }>} existing
 * @param {object} brainConfig
 * @param {object} [deps]
 * @returns {Promise<string[]>}
 */
export async function findRelatedPagePaths(fact, existing, brainConfig, deps = {}) {
  if (!fact.title && !fact.body) return [];

  const { minSharedTitleKeywords, minCosine, maxLinks } = linkingConfig(brainConfig);

  const cosines = await scorePagesByCosine(
    `${fact.title} ${fact.body}`.trim(),
    existing,
    brainConfig,
    deps,
  );

  const kNew = titleKeywords(fact.title);
  /** @type {Array<{ relPath: string, score: number }>} */
  const qualified = [];

  for (const row of existing) {
    const relPath = row.meta?.path;
    if (!relPath) continue;
    const shared = sharedKeywordCount(kNew, titleKeywords(row.meta.title));
    const cosine = cosines.get(row.meta.id) ?? 0;
    if (shared < minSharedTitleKeywords && cosine < minCosine) continue;
    qualified.push({ relPath, score: shared + 2 * cosine });
  }

  return qualified
    .sort((a, b) => b.score - a.score)
    .slice(0, maxLinks)
    .map((row) => row.relPath);
}

// ── Synthesis ────────────────────────────────────────────────────────────────

/**
 * @param {{ confidence?: number }} fact
 * @param {{ confidenceThreshold?: number, requireConfirmation?: boolean, autoWriteConfidence?: number }} cfg
 * @returns {'skip-low' | 'propose' | 'write'}
 */
export function routeSynthesisFact(fact, cfg = {}) {
  const confidence = typeof fact?.confidence === 'number' ? fact.confidence : 0;
  const floor = cfg.confidenceThreshold ?? 0.6;
  if (confidence < floor) return 'skip-low';
  if (cfg.requireConfirmation === true) return 'propose';
  const autoWrite = cfg.autoWriteConfidence ?? 0.85;
  return confidence >= autoWrite ? 'write' : 'propose';
}

/**
 * @param {{ messages: Array<{ role?: string, content?: string | unknown[] }>, sourceChatId?: string, sourceExcerpt?: string, providerId?: string, modelId?: string, }} input
 * @returns {Promise<{ memoryProposals: object[], pages: object[], skipped: string[] }>}
 */
export async function runMemorySynthesis(input) {
  const cfg = await loadSynthesisConfig();
  if (!cfg.enabled) {
    return { memoryProposals: [], pages: [], skipped: ['disabled'] };
  }

  const modelBinding = await resolveSynthesisModel(cfg, {
    providerId: input.providerId,
    modelId: input.modelId,
  });
  if (!modelBinding?.providerId || !modelBinding?.model) {
    return { memoryProposals: [], pages: [], skipped: ['no-model'] };
  }

  const conversation = formatMessagesForExtraction(input.messages ?? [], {
    window: 20,
    perMessageChars: 700,
    roles: ['user', 'assistant'],
  });
  if (!conversation.trim()) {
    return { memoryProposals: [], pages: [], skipped: ['empty-context'] };
  }

  const raw = await llmCall({
    providerId: modelBinding.providerId,
    model: modelBinding.model,
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: `Conversation:\n${conversation}` },
    ],
    temperature: 0.2,
    maxTokens: 1024,
    timeoutMs: 45_000,
  });

  const parsed = parseExtractionJson(raw);
  const brainConfig = await loadBrainConfig();
  const existing = await loadAllPagesWithBodies();
  const pendingTitles = new Set();

  /** @type {object[]} */
  const created = [];
  /** @type {object[]} */
  const pages = [];
  /** @type {string[]} */
  const skipped = [];

  const maxPerTurn = Math.max(1, cfg.maxProposalsPerTurn ?? 3);

  for (const row of parsed) {
    if (created.length + pages.length >= maxPerTurn) break;
    const fact = normalizeExtractedFact(row);
    if (!fact) {
      skipped.push('invalid-or-secret');
      continue;
    }

    const route = routeSynthesisFact(fact, cfg);
    const expertId =
      typeof input.expertId === 'string' ? input.expertId.trim() : '';
    const effectiveRoute = expertId ? 'propose' : route;
    if (effectiveRoute === 'skip-low') {
      skipped.push('low-confidence');
      continue;
    }

    if (pendingTitles.has(fact.title.toLowerCase())) {
      skipped.push('duplicate-in-batch');
      continue;
    }
    if (await isDuplicateMemory(fact.title, fact.body, existing, brainConfig)) {
      skipped.push('duplicate-existing');
      continue;
    }

    if (effectiveRoute === 'propose') {
      const proposal = await addMemoryProposal({
        ...fact,
        sourceChatId: input.sourceChatId,
        sourceExcerpt: input.sourceExcerpt,
        ...(expertId ? { expertId } : {}),
      });
      pendingTitles.add(fact.title.toLowerCase());
      created.push(proposal);
    } else {
      const similarTo = await findRelatedPagePaths(fact, existing, brainConfig);
      const written = await writeSynthesisFactPage(fact, similarTo);
      pendingTitles.add(fact.title.toLowerCase());
      pages.push(written.page);
      void retireSupersededPages(fact, written.relPath, existing, brainConfig);
      existing.push({ meta: written.page.meta, body: written.page.body });
    }
  }

  return { memoryProposals: created, pages, skipped };
}
