/**
 * Skills Library HTTP routes under /api/skills/library/* (MIN-475).
 */

import {
  SKILLS_LIBRARY_PACKS,
  getSkillsLibraryPack,
} from '../../../src/skills/library/registry.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getUserSkillsRoot } from '../scan.js';
import { countInstalledByPack, readProvenance } from './provenance.js';
import { loadShippedPackIndex, searchShippedIndexes } from './index-loader.js';
import {
  installPackSkill,
  installSkillFromRepoUrl,
  removeInstalledSkill,
  removePackInstalledSkills,
} from './install.js';

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
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

/**
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
export async function handleSkillsLibraryRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/skills/library')) {
    return false;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');

  try {
    if (pathname === '/api/skills/library/packs' && req.method === 'GET') {
      const [installedCounts, indexes] = await Promise.all([
        countInstalledByPack(),
        Promise.all(
          SKILLS_LIBRARY_PACKS.map(async (pack) => {
            const index = await loadShippedPackIndex(pack.id);
            return { packId: pack.id, totalCount: index.skills.length };
          }),
        ),
      ]);

      const totalByPack = Object.fromEntries(indexes.map((row) => [row.packId, row.totalCount]));

      sendJson(res, 200, {
        packs: SKILLS_LIBRARY_PACKS.map((pack) => ({
          id: pack.id,
          label: pack.label,
          description: pack.description,
          publisher: pack.publisher,
          trust: pack.trust,
          runtimeNote: pack.runtimeNote,
          postInstallPatch: pack.postInstallPatch,
          source: {
            repo: pack.source.repo,
            commit: pack.source.commit,
          },
          installedCount: installedCounts[pack.id] ?? 0,
          totalCount: totalByPack[pack.id] ?? 0,
        })),
      });
      return true;
    }

    const indexMatch = pathname.match(/^\/api\/skills\/library\/packs\/([^/]+)\/index$/);
    if (indexMatch && req.method === 'GET') {
      const packId = decodeURIComponent(indexMatch[1]);
      const index = await loadShippedPackIndex(packId);
      sendJson(res, 200, { index });
      return true;
    }

    if (pathname === '/api/skills/library/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const results = await searchShippedIndexes(q);
      sendJson(res, 200, { query: q, results });
      return true;
    }

    if (pathname === '/api/skills/library/install' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const repoUrl = typeof body.repoUrl === 'string' ? body.repoUrl.trim() : '';

      if (repoUrl) {
        const subpath = typeof body.subpath === 'string' ? body.subpath.trim() : undefined;
        const installed = await installSkillFromRepoUrl(repoUrl, subpath);
        sendJson(res, 201, { ok: true, installed: [installed] });
        return true;
      }

      const packId = typeof body.pack === 'string' ? body.pack.trim() : '';
      if (!packId) {
        sendJson(res, 400, { error: 'pack or repoUrl is required' });
        return true;
      }

      const pack = getSkillsLibraryPack(packId);
      if (!pack) {
        sendJson(res, 404, { error: `Unknown pack: ${packId}` });
        return true;
      }

      const index = await loadShippedPackIndex(packId);
      const installAll = body.all === true;
      const requestedIds = Array.isArray(body.skillIds)
        ? body.skillIds.filter((id) => typeof id === 'string').map((id) => id.trim())
        : [];

      /** @type {import('../../../src/skills/library/registry.ts').SkillsLibraryIndexSkill[]} */
      let targets = [];
      const skipped = [];
      if (installAll) {
        const provenance = await readProvenance();
        for (const skill of index.skills) {
          let present = false;
          try {
            present = (await fs.stat(path.join(getUserSkillsRoot(), skill.skillId))).isDirectory();
          } catch (err) {
            if (err?.code !== 'ENOENT') throw err;
          }
          if (present && provenance[skill.skillId]) skipped.push({ skillId: skill.skillId, reason: 'already installed' });
          else targets.push(skill);
        }
      } else if (requestedIds.length > 0) {
        const byId = new Map(index.skills.map((skill) => [skill.skillId, skill]));
        for (const id of requestedIds) {
          const row = byId.get(id);
          if (!row) {
            sendJson(res, 400, { error: `Unknown skill id for pack ${packId}: ${id}` });
            return true;
          }
          targets.push(row);
        }
      } else {
        sendJson(res, 400, { error: 'skillIds, all, or repoUrl is required' });
        return true;
      }

      const installed = [];
      const failed = [];
      for (const skill of targets) {
        try {
          installed.push(await installPackSkill(pack, skill));
        } catch (err) {
          failed.push({ skillId: skill.skillId, error: err instanceof Error ? err.message : String(err) });
        }
      }

      sendJson(res, failed.length ? 207 : 201, { ok: failed.length === 0, installed, skipped, failed });
      return true;
    }

    if (pathname === '/api/skills/library/remove' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const packId = typeof body.pack === 'string' ? body.pack.trim() : '';
      const removeAll = body.all === true;

      if (packId && removeAll) {
        const pack = getSkillsLibraryPack(packId);
        if (!pack) {
          sendJson(res, 404, { error: `Unknown pack: ${packId}` });
          return true;
        }

        const result = await removePackInstalledSkills(packId);
        sendJson(res, result.failed.length ? 207 : 200, { ok: result.failed.length === 0, ...result });
        return true;
      }

      const skillId = typeof body.skillId === 'string' ? body.skillId.trim() : '';
      if (!skillId) {
        sendJson(res, 400, { error: 'skillId or pack+all is required' });
        return true;
      }

      const removed = await removeInstalledSkill(skillId);
      sendJson(res, 200, { ok: true, ...removed });
      return true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith('Unknown pack') ? 404 : 400;
    sendJson(res, status, { error: message });
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
