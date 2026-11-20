/**
 * HTTP handlers for memory/skill synthesis and proposal review APIs.
 */

import { createUserSkill, saveUserSkillContent } from '../skills/user-skills.js';
import { parseSkillFrontmatter } from '../skills/parse-frontmatter.js';
import { getAppRoot } from '../workspace/root.js';
import { loadSynthesisConfig, saveSynthesisConfig } from './synthesis-config.js';
import { writeSynthesisFactPage } from './synthesis.js';
import { runSkillSynthesis } from './skill-synthesis.js';
import { incrementMessagePairs, getMessagePairs } from './synthesis-state.js';
import {
  listMemoryProposals,
  getMemoryProposal,
  updateMemoryProposalStatus,
  applyMemoryProposalEdits,
  countPendingMemoryProposals,
} from './proposals.js';
import { clearSynthesisProposals } from './clear-synthesis-proposals.js';
import {
  listSkillProposals,
  getSkillProposal,
  updateSkillProposalStatus,
  applySkillProposalEdits,
  countPendingSkillProposals,
} from '../skills/proposals.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Map wiki page meta to legacy memory entry shape for API responses. */
function pageMetaToEntry(meta) {
  return {
    id: meta.id,
    title: meta.title,
    tags: meta.tags ?? [],
    source: meta.source === 'agent' || meta.source === 'synthesis' ? meta.source : 'user',
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    pinned: Boolean(meta.pinned),
  };
}

/**
 * Handle synthesis and proposal routes under /api/memory and /api/skills.
 * @returns {Promise<boolean>}
 */
export async function handleSynthesisRequest(req, res, pathname) {
  const isMemory = pathname.startsWith('/api/memory/');
  const isSkills = pathname.startsWith('/api/skills/');
  if (!isMemory && !isSkills) return false;

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    if (pathname === '/api/memory/synthesis/config' && req.method === 'GET') {
      const synthesis = await loadSynthesisConfig();
      sendJson(res, 200, { synthesis });
      return true;
    }

    if (pathname === '/api/memory/synthesis/config' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const synthesis = await saveSynthesisConfig(body);
      sendJson(res, 200, { synthesis });
      return true;
    }

    if (pathname === '/api/memory/synthesis/status' && req.method === 'GET') {
      const [memoryPending, skillPending] = await Promise.all([
        countPendingMemoryProposals(),
        countPendingSkillProposals(),
      ]);
      sendJson(res, 200, {
        memoryPending,
        skillPending,
        totalPending: memoryPending + skillPending,
      });
      return true;
    }

    if (pathname === '/api/memory/synthesis/run' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const cfg = await loadSynthesisConfig();
      if (!cfg.enabled) {
        sendJson(res, 200, {
          ok: true,
          skipped: ['disabled'],
          memoryProposals: [],
          memoryPages: [],
          skillProposal: null,
        });
        return true;
      }

      const chatId =
        typeof body.chatId === 'string' ? body.chatId.trim() : '';
      const force = body.force === true;
      const boardChat = body.boardChat === true;
      if (boardChat && !force && cfg.includeBoardChats !== true) {
        sendJson(res, 200, {
          ok: true,
          skipped: ['board-chat'],
          memoryProposals: [],
          memoryPages: [],
          skillProposal: null,
        });
        return true;
      }
      const pairCount = chatId
        ? force
          ? await getMessagePairs(chatId)
          : await incrementMessagePairs(chatId)
        : Number(body.messagePairCount) || 1;
      const throttle = Math.max(1, cfg.throttleMessagePairs ?? 4);

      if (!force && pairCount % throttle !== 0) {
        sendJson(res, 200, {
          ok: true,
          skipped: ['throttled'],
          messagePairs: pairCount,
          memoryProposals: [],
          memoryPages: [],
          skillProposal: null,
        });
        return true;
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const roundCount =
        typeof body.roundCount === 'number' ? body.roundCount : 1;
      const toolCount =
        typeof body.toolCount === 'number' ? body.toolCount : 0;

      // Memories are written only by explicit agent or user actions; background
      // synthesis proposes skills only.
      const skillResult = await runSkillSynthesis({
        messages,
        roundCount,
        toolCount,
        sourceChatId: chatId || undefined,
      });

      sendJson(res, 200, {
        ok: true,
        messagePairs: pairCount,
        memoryProposals: [],
        memoryPages: [],
        memorySkipped: ['retired'],
        skillProposal: skillResult.skillProposal,
        skillSkipped: skillResult.skipped,
      });
      return true;
    }

    if (pathname === '/api/memory/proposals' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const status = url.searchParams.get('status') ?? undefined;
      const expertId = url.searchParams.get('expertId') ?? undefined;
      const proposals = await listMemoryProposals(
        /** @type {'pending' | 'accepted' | 'rejected' | undefined} */ (status),
        expertId,
      );
      sendJson(res, 200, { proposals });
      return true;
    }

    if (pathname === '/api/memory/proposals/clear' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirmed !== true) {
        sendJson(res, 400, { error: 'confirmed: true is required' });
        return true;
      }
      const scope = body.scope === 'all' ? 'all' : 'pending';
      const result = await clearSynthesisProposals(scope);
      sendJson(res, 200, result);
      return true;
    }

    const memoryAcceptMatch = pathname.match(
      /^\/api\/memory\/proposals\/([^/]+)\/accept$/,
    );
    if (memoryAcceptMatch && req.method === 'POST') {
      const id = decodeURIComponent(memoryAcceptMatch[1]);
      const body = await readJsonBody(req);
      const existing = await getMemoryProposal(id);
      if (!existing) {
        sendJson(res, 404, { error: 'Proposal not found' });
        return true;
      }
      if (existing.status !== 'pending') {
        sendJson(res, 409, { error: 'Proposal already resolved' });
        return true;
      }

      const edited = await applyMemoryProposalEdits(id, {
        title: body.title,
        body: body.body,
        tags: body.tags,
      });
      const row = edited ?? existing;
      const expertId =
        typeof row.expertId === 'string' ? row.expertId.trim() : '';
      const writeOpts = { source: 'agent' };
      if (expertId && /^[a-z][a-z0-9-]{0,63}$/.test(expertId)) {
        writeOpts.dir = `experts/${expertId}/facts`;
      }
      const { page } = await writeSynthesisFactPage(
        {
          title: row.title,
          body: row.body,
          tags: row.tags,
          category: row.category,
          scope: row.scope,
        },
        [],
        writeOpts,
      );
      await updateMemoryProposalStatus(id, 'accepted');
      sendJson(res, 200, { ok: true, entry: pageMetaToEntry(page.meta), proposalId: id });
      return true;
    }

    const memoryRejectMatch = pathname.match(
      /^\/api\/memory\/proposals\/([^/]+)\/reject$/,
    );
    if (memoryRejectMatch && req.method === 'POST') {
      const id = decodeURIComponent(memoryRejectMatch[1]);
      const row = await updateMemoryProposalStatus(id, 'rejected');
      if (!row) {
        sendJson(res, 404, { error: 'Proposal not found' });
        return true;
      }
      sendJson(res, 200, { ok: true, proposalId: id });
      return true;
    }

    if (pathname === '/api/skills/proposals' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const status = url.searchParams.get('status') ?? undefined;
      const proposals = await listSkillProposals(
        /** @type {'pending' | 'accepted' | 'rejected' | undefined} */ (status),
      );
      sendJson(res, 200, { proposals });
      return true;
    }

    const skillAcceptMatch = pathname.match(
      /^\/api\/skills\/proposals\/([^/]+)\/accept$/,
    );
    if (skillAcceptMatch && req.method === 'POST') {
      const id = decodeURIComponent(skillAcceptMatch[1]);
      const body = await readJsonBody(req);
      const existing = await getSkillProposal(id);
      if (!existing) {
        sendJson(res, 404, { error: 'Proposal not found' });
        return true;
      }
      if (existing.status !== 'pending') {
        sendJson(res, 409, { error: 'Proposal already resolved' });
        return true;
      }

      if (body.skillMdDraft !== undefined) {
        await applySkillProposalEdits(id, {
          skillMdDraft: body.skillMdDraft,
        });
      }
      const row = (await getSkillProposal(id)) ?? existing;
      const draft = row.skillMdDraft;
      const { meta } = parseSkillFrontmatter(draft);
      const skillId = meta.name.trim();
      const label = meta.label?.trim() || existing.title;

      const projectRoot = getAppRoot();
      try {
        await createUserSkill(projectRoot, skillId, label);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('already exists')) {
          throw err;
        }
      }
      await saveUserSkillContent(skillId, draft);
      await updateSkillProposalStatus(id, 'accepted');
      sendJson(res, 200, { ok: true, skillId, proposalId: id });
      return true;
    }

    const skillRejectMatch = pathname.match(
      /^\/api\/skills\/proposals\/([^/]+)\/reject$/,
    );
    if (skillRejectMatch && req.method === 'POST') {
      const id = decodeURIComponent(skillRejectMatch[1]);
      const row = await updateSkillProposalStatus(id, 'rejected');
      if (!row) {
        sendJson(res, 404, { error: 'Proposal not found' });
        return true;
      }
      sendJson(res, 200, { ok: true, proposalId: id });
      return true;
    }

    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /** @type {{ statusCode?: number }} */ (err).statusCode ?? 500;
    sendJson(res, status, { error: message });
    return true;
  }
}
