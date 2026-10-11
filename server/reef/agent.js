import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveHeadlessRunEntry } from '../scheduler/headless-entry.js';
import { getSessionToken } from '../runtime/session-token.js';
import { getMinnowHome } from '../config/home.js';
import { applyNodeRuntimeEnv } from '../lsp/node-runtime.js';
import { command, cleanEnvironment } from './process.js';
import { appRoot, safePath, updateApp } from './store.js';
import { createAgentEventParser } from './agent-stream.js';
import { disposeCliSessions } from '../generations/agent-cli/lifecycle.js';

export async function runAgent({ app, runId, workspace, prompt, phase, baseUrl, signal, log, stream, event, execute = command }) {
  const chatId = randomUUID();
  // A running response keeps its model; each fresh agent reads the app's latest choice.
  app = await updateApp(app.id, current => {
    current.chatIds.push(chatId);
    current.runs.find(run => run.id === runId)?.chatIds.push(chatId);
  });
  const output = await safePath(appRoot(app.id), 'runs', `${chatId}.json`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const entry = resolveHeadlessRunEntry();
  const args = [entry.script, 'run', '--stdin', '--base-url', baseUrl, '--workspace', workspace,
    '--agent', phase === 'build' ? 'builder' : 'planner',
    '--mode', phase === 'build' ? 'build' : 'plan', '--model', app.modelId,
    '--no-approval', '--auto-reject-questions', '--persist-chat', '--chat-id', chatId,
    '--chat-name', `Reef · ${app.name} · ${phase}`, '--json-out', output, '--quiet'];
  if (app.providerId) args.push('--provider', app.providerId);
  if (event) args.push('--stream-json');
  else if (stream) { args.push('--stream'); stream(`\n\n${phase === 'plan' ? 'Planning your app' : 'Building your app'}\nWaiting for the model…\n`); }
  event?.({ type: 'agent_start', chatId, phase });
  let commandError;
  try { await execute(process.execPath, args, {
    cwd: entry.cwd, input: prompt, signal, log, timeout: 0,
    stdout: event ? createAgentEventParser(value => event({ ...value, chatId, phase })) : stream,
    env: applyNodeRuntimeEnv(cleanEnvironment({
      MINNOW_HOME: getMinnowHome(),
      MINNOW_TOKEN: getSessionToken(), MINNOW_REEF_PHASE: phase,
      MINNOW_I_UNDERSTAND_UNSAFE_AUTOMATION: '1',
    }), process.execPath),
  }); } catch (error) { commandError = error; }
  finally {
    // Each attempt has a fresh chat; its native process cannot serve the next one.
    try { await disposeCliSessions(session => session.chatId === chatId); }
    catch (error) { commandError ??= error; }
  }
  let result;
  try { result = JSON.parse(await fs.readFile(output, 'utf8')); } catch {}
  const error = signal?.aborted ? signal.reason : result && !result.ok ? new Error(result.error || 'Agent run failed')
    : commandError ?? (!result ? new Error('Agent did not write its result') : null);
  event?.({ type: 'agent_end', chatId, phase, error: error ? String(error.message ?? error) : undefined });
  if (error) throw error;
  return { text: result.assistantFinal, chatId };
}
