import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveHeadlessRunEntry } from '../scheduler/headless-entry.js';
import { getSessionToken } from '../runtime/session-token.js';
import { getMinnowHome } from '../config/home.js';
import { applyNodeRuntimeEnv } from '../lsp/node-runtime.js';
import { command, cleanEnvironment } from './process.js';
import { appRoot, safePath, updateApp } from './store.js';

export async function runAgent({ app, runId, workspace, prompt, phase, baseUrl, signal, log }) {
  const chatId = randomUUID();
  await updateApp(app.id, current => {
    current.chatIds.push(chatId);
    current.runs.find(run => run.id === runId)?.chatIds.push(chatId);
  });
  const output = await safePath(appRoot(app.id), 'runs', `${chatId}.json`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const entry = resolveHeadlessRunEntry();
  const args = [entry.script, 'run', '--stdin', '--base-url', baseUrl, '--workspace', workspace,
    '--mode', phase === 'build' ? 'build' : 'plan', '--model', app.modelId,
    '--no-approval', '--auto-reject-questions', '--persist-chat', '--chat-id', chatId,
    '--chat-name', `Reef · ${app.name} · ${phase}`, '--json-out', output, '--quiet'];
  if (app.providerId) args.push('--provider', app.providerId);
  await command(process.execPath, args, {
    cwd: entry.cwd, input: prompt, signal, log,
    env: applyNodeRuntimeEnv(cleanEnvironment({
      MINNOW_HOME: getMinnowHome(),
      MINNOW_TOKEN: getSessionToken(), MINNOW_REEF_PHASE: phase,
      MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION: '1',
    }), process.execPath),
  });
  const result = JSON.parse(await fs.readFile(output, 'utf8'));
  if (!result.ok) throw new Error(result.error || 'Agent run failed');
  return { text: result.assistantFinal, chatId };
}
