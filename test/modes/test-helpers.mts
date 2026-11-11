/**
 * Shared helpers for mode unit tests.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerWorkAgentFilesFromRaw,
  resetWorkAgentRegistry,
  setWorkAgentRegistryIndex,
} from '../../src/agents/work-agent-registry.ts';
import registryIndex from '../../src/chat/prompts/work-agents/registry.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

export function repoPath(...segments: string[]): string {
  return path.join(REPO_ROOT, ...segments);
}

/** Load shipped mode prompt files into a Vite-style glob map for registerPromptFilesFromRaw. */
export async function loadBuiltinModePromptMap(): Promise<Record<string, string>> {
  const modesDir = repoPath('src/chat/prompts/modes');
  const ids = [
    'general',
    'build',
    'plan',
    'super-plan',
    'orchestrate',
    'debug',
    'onboarding',
  ] as const;
  const map: Record<string, string> = {};
  for (const id of ids) {
    const fileName = `${id}.full.md`;
    const abs = path.join(modesDir, fileName);
    const key = `./modes/${fileName}`;
    map[key] = await fs.readFile(abs, 'utf8');
  }
  return map;
}

/** Load shipped work-agent prompt files for registerWorkAgentFilesFromRaw. */
export async function loadBuiltinWorkAgentPromptMap(): Promise<Record<string, string>> {
  const agentsDir = repoPath('src/chat/prompts/work-agents');
  const entries = await fs.readdir(agentsDir, { withFileTypes: true });
  const map: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const fileName = 'agent.full.md';
    const abs = path.join(agentsDir, entry.name, fileName);
    try {
      map[`./work-agents/${entry.name}/${fileName}`] = await fs.readFile(abs, 'utf8');
    } catch {
      /* skip directories without an agent prompt */
    }
  }
  return map;
}

/** Register shipped work agents (required for defaultForModes / mode suppression tests). */
export async function registerShippedWorkAgents(): Promise<void> {
  resetWorkAgentRegistry();
  setWorkAgentRegistryIndex(registryIndex as { ids: string[] });
  registerWorkAgentFilesFromRaw(await loadBuiltinWorkAgentPromptMap());
}
