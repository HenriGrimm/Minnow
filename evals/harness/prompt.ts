import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initBuiltinPromptRegistry } from '../../src/chat/prompts/prompt-loader';
import { composeSystemPrompt } from '../../src/chat/prompts/prompt-composer';
import { initBuiltinWorkAgentRegistry } from '../../src/agents/work-agent-registry';

export function benchmarkPrompt(profile: string, cwd: string, tools: string[]): string {
  if (profile === 'minimal') return 'You are a helpful software engineer assistant.';
  if (profile !== 'build') throw new Error(`Unknown prompt profile: ${profile}`);
  // The model acts in a Linux sandbox even when the coordinator is on Windows.
  Object.defineProperty(globalThis, 'navigator', { value: { platform: 'Linux' }, configurable: true });
  const root = fileURLToPath(new URL('../../src/chat/prompts/', import.meta.url));
  const raw: Record<string, string> = {};
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const filename = path.join(entry.parentPath, entry.name);
      raw[path.relative(root, filename).replaceAll('\\', '/')] = fs.readFileSync(filename, 'utf8');
    }
  }
  initBuiltinPromptRegistry(raw);
  initBuiltinWorkAgentRegistry(raw);
  return composeSystemPrompt({
    profile: 'full', cwd, modeId: 'build', expertId: null,
    workAgentId: 'builder', skillBody: null, memoryBlock: null,
    codeMapBlock: null, contextDocumentsBlock: null, enabledToolIds: tools,
    infoPresetId: null, shellSandboxMode: 'off',
  });
}
