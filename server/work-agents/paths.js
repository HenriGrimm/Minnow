/**
 * Safe paths for Work Agent user data under MINNOW_HOME.
 */

import path from 'node:path';
import { getMinnowHome } from '../config/home.js';

const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** Pack-sourced ids: packId.agentKey */
const PACK_AGENT_ID_RE = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$/;

/**
 * Validate work agent id segment (no traversal).
 * @param {string} agentId
 */
export function assertValidWorkAgentId(agentId) {
  if (
    !agentId ||
    typeof agentId !== 'string' ||
    (!AGENT_ID_RE.test(agentId) && !PACK_AGENT_ID_RE.test(agentId))
  ) {
    throw new Error('Invalid work agent id');
  }
}

/**
 * ~/.minnow/work-agents.json
 */
export function workAgentsOverridesPath() {
  return path.join(getMinnowHome(), 'work-agents.json');
}

/**
 * ~/.minnow/prompts/work-agents/<id>/agent.full.md
 * @param {string} agentId
 */
export function workAgentPromptOverridePath(agentId) {
  assertValidWorkAgentId(agentId);
  const home = path.resolve(getMinnowHome());
  const rel = path.join('prompts', 'work-agents', agentId, `agent.full.md`);
  const full = path.resolve(home, rel);
  const homeWithSep = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  if (full !== home && !full.startsWith(homeWithSep)) {
    throw new Error('Invalid path');
  }
  return full;
}

/**
 * Shipped prompts under repo src/chat/prompts/work-agents/
 * @param {string} projectRoot
 * @param {string} agentId
 */
export function builtinWorkAgentPromptPath(projectRoot, agentId) {
  assertValidWorkAgentId(agentId);
  const root = path.resolve(projectRoot);
  const rel = path.join('src', 'chat', 'prompts', 'work-agents', agentId, `agent.full.md`);
  const full = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (full !== root && !full.startsWith(rootWithSep)) {
    throw new Error('Invalid path');
  }
  return full;
}

export function builtinWorkAgentsDir(projectRoot) {
  return path.join(projectRoot, 'src', 'chat', 'prompts', 'work-agents');
}
