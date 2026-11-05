import path from 'node:path';
import { readConfigJson } from '../config/store.js';
import { readRecentPathsFromMeta } from '../workspace/root.js';
import { brainWorkspaceKeyFromPath, legacyBrainWorkspaceSlug } from './paths.js';

const scopedKey = /--[a-f0-9]{32}$/;

// Both the source chat ID and its expected captured path must agree with the
// conversation store. Handwritten pages and uncertain archives stay in place.
function legacyChatSource(page) {
  const [, slug, rest] = /^workspaces\/([^/]+)\/(.+)$/.exec(page.path) ?? [];
  const id = page.chatId;
  if (!slug || scopedKey.test(slug) || page.assignedWorkspace || !id || /[\\/]/.test(id)) return null;
  if (rest !== 'summaries/chat-' + id + '.md' && !(page.source === 'archive' && rest.startsWith('archive/' + id + '/'))) return null;
  return { id, slug };
}

async function chatRootLookup() {
  const { useJsonSessionsStore, readChatWorkspacePath } = await import('../config/sessions-repo.js');
  if (!useJsonSessionsStore()) return readChatWorkspacePath;
  const { readResource } = await import('../config/store.js');
  const sessions = await readResource('sessions');
  const roots = new Map();
  for (const chat of sessions?.chats ?? []) {
    const existing = roots.get(chat.id);
    roots.set(chat.id, roots.has(chat.id) && existing !== chat.workspacePath ? null : chat.workspacePath);
  }
  return id => roots.get(id);
}

/** Resolve proven legacy owners in memory. This inventory never rewrites pages. */
export async function resolveLegacyOwners(pages, lookup) {
  const roots = new Map();
  const keys = new Map();
  const result = [];
  for (const page of pages) {
    const source = legacyChatSource(page);
    let assignedWorkspace;
    if (source) {
      try {
        lookup ??= await chatRootLookup();
        if (!roots.has(source.id)) roots.set(source.id, lookup(source.id));
        const root = roots.get(source.id);
        if (typeof root === 'string' && path.isAbsolute(root) && legacyBrainWorkspaceSlug(root) === source.slug) {
          if (!keys.has(root)) keys.set(root, brainWorkspaceKeyFromPath(root));
          assignedWorkspace = keys.get(root);
        }
      } catch { /* An unavailable conversation store cannot establish ownership. */ }
    }
    result.push(assignedWorkspace ? { ...page, assignedWorkspace } : page);
  }
  return result;
}

export async function inspectBrainWorkspace(page, root) {
  const slug = page.path.split('/')[1];
  const [scoped] = await resolveLegacyOwners([page]);
  const currentKey = brainWorkspaceKeyFromPath(root);
  const recent = readRecentPathsFromMeta(await readConfigJson('config.json'));
  const candidates = new Set();
  for (const candidate of [root, ...recent]) {
    if (legacyBrainWorkspaceSlug(candidate) !== slug) continue;
    try { candidates.add(brainWorkspaceKeyFromPath(candidate)); } catch { /* unavailable */ }
  }
  return { currentKey, ownerKey: scoped.assignedWorkspace || (scopedKey.test(slug) ? slug : null), ambiguous: candidates.size > 1 };
}
