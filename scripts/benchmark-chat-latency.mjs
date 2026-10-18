import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createGenerationState, addLocalSubscriber, cancel } from '../server/generations/store.js';
import { pumpUpstreamAsync } from '../server/generations/upstream.js';
import { pumpAgentCliUpstream } from '../server/generations/agent-cli/pump.js';
import { disposeCliSessions } from '../server/generations/agent-cli/lifecycle.js';
import { cliCacheDir, removeCliCache } from '../server/generations/agent-cli/checkpoints.js';
import { getProviderRuntime } from '../server/providers/store.js';
import { runWithViewWorkspace } from '../server/runtime/path-access.js';
import { createSseEventBuffer, feedSseEventBuffer, flushSseEventBuffer } from '../server/runner/sse-parse.js';
import { mergeToolCallDelta, finalizeToolCalls } from '../server/runner/stream-parse.js';

const tools = [{ type: 'function', function: { name: 'lookup_nonce',
  description: 'Read-only benchmark tool returning a nonce. No files or external services are accessed.',
  parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } } }];
const prose = 'Write exactly five short numbered lines explaining why small software changes are easier to review. No introduction or conclusion. Do not call tools.';
const roundMs = value => value == null ? null : Math.round(value * 10) / 10;

/** Synthetic account inference through production generation adapters, without chat persistence. */
export async function benchmarkChatLatency({ targets, samples = 3, output, timeoutMs = 60_000, restart = false }) {
  if (!Array.isArray(targets) || !targets.length || targets.some(t => !t.providerId || !t.model || t.kind && !['codex', 'claude', 'cursor'].includes(t.kind))) {
    throw new Error('Targets require providerId, model and an optional codex/claude/cursor kind.');
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 10) throw new Error('Samples must be 1–10.');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-chat-latency-'));
  const results = { startedAt: new Date().toISOString(), samples, restart, prompt: prose, reasoningEffort: 'low',
    scope: 'Production generation adapters to local stream subscriber; excludes browser paint. Synthetic prompts only.', rows: [], trials: [] };
  const save = async () => {
    if (!output) return;
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, JSON.stringify(results, null, 2) + '\n');
  };
  async function generation(target, chatId, messages, scenario, sample) {
    const state = createGenerationState({ providerId: target.providerId, chatId, fallbackRole: 'default',
      body: { model: target.model, messages, tools, stream: true, reasoning_effort: 'low', max_tokens: 2048 },
      modelCapabilities: { reasoning: { supported: true, allowed_options: ['low', 'medium', 'high'] } } });
    state.failoverDisabled = true;
    const started = performance.now(), gaps = [];
    let firstVisible, firstText, firstTool, lastOutput, ended, content = '', reasoning = '', toolAcc = {}, metadata, usage;
    const buffer = createSseEventBuffer(), decoder = new TextDecoder();
    const row = { provider: target.providerId, model: target.model, transport: target.kind ?? 'api', scenario, sample };
    const onChunk = chunk => {
      const now = performance.now() - started;
      const delta = chunk.choices?.[0]?.delta;
      const text = typeof delta?.content === 'string' ? delta.content : '';
      const thought = delta?.reasoning_content ?? delta?.reasoning ?? '';
      if (text || thought || delta?.tool_calls?.length) {
        firstVisible ??= now;
        if (lastOutput != null) gaps.push(now - lastOutput);
        lastOutput = now;
      }
      if (text) { firstText ??= now; content += text; }
      if (thought) reasoning += thought;
      if (delta?.tool_calls?.length) firstTool ??= now;
      toolAcc = mergeToolCallDelta(toolAcc, chunk);
      if (chunk.minnow_cli) metadata = chunk.minnow_cli;
      if (chunk.usage) usage = chunk.usage;
    };
    const unsubscribe = addLocalSubscriber(state, {
      onChunk: bytes => feedSseEventBuffer(buffer, decoder.decode(bytes, { stream: true }), onChunk),
      onEnd: () => { ended = performance.now() - started; },
    });
    const timer = setTimeout(() => cancel(state), timeoutMs);
    try {
      await runWithViewWorkspace(workspace, async () => {
        if (target.kind) {
          const runtime = ['codex', 'cursor'].includes(target.kind)
            ? { profile: { agentCli: { kind: target.kind, maxConcurrent: 1 } }, secrets: {} }
            : await getProviderRuntime(target.providerId);
          await pumpAgentCliUpstream({ state, runtime, candidate: { providerId: target.providerId, modelId: target.model },
            index: 0, idleMs: timeoutMs, maxMs: timeoutMs, canFailover: false });
        } else await pumpUpstreamAsync({ state });
      });
      flushSseEventBuffer(buffer, onChunk);
      const calls = finalizeToolCalls(toolAcc);
      Object.assign(row, { status: state.status, error: state.errorMessage || undefined,
        firstVisibleMs: roundMs(firstVisible), firstTextMs: roundMs(firstText), firstToolMs: roundMs(firstTool),
        completeMs: roundMs(ended ?? performance.now() - started),
        tailMs: lastOutput == null ? null : roundMs((ended ?? performance.now() - started) - lastOutput),
        maxOutputGapMs: roundMs(gaps.length ? Math.max(...gaps) : null),
        outputChars: content.length, reasoningChars: reasoning.length, toolCalls: calls.length, metadata, usage });
      if (state.status !== 'complete') throw new Error(row.error ?? `Generation ${state.status}`);
      messages.push({ role: 'assistant', content: content.trim(), ...(calls.length ? { tool_calls: calls } : {}) });
      return { calls, content, row };
    } catch (error) {
      row.status = state.status === 'complete' ? 'error' : state.status;
      row.error = error.message;
      throw error;
    } finally {
      clearTimeout(timer); clearTimeout(state.evictTimer); unsubscribe();
      results.rows.push(row); await save(); console.log(JSON.stringify(row));
    }
  }
  try {
    for (let sample = 1; sample <= samples; sample++) {
      const order = sample % 2 ? targets : [...targets].reverse();
      for (const target of order) {
        let trialError;
        const chatId = `latency-${randomUUID()}`;
        const messages = [{ role: 'system', content: 'Follow the user instructions concisely. Use only the supplied lookup_nonce tool when requested. Do not inspect the workspace.' },
          { role: 'user', content: prose }];
        try {
          for (const scenario of ['cold-prose', 'warm-prose']) {
            if (scenario === 'warm-prose') messages.push({ role: 'user', content: prose });
            const turn = await generation(target, chatId, messages, scenario, sample);
            if (turn.calls.length || !turn.content.trim()) throw new Error('Prose trial did not return text only.');
          }
          messages.push({ role: 'user', content: 'Call lookup_nonce exactly once with label "probe", then reply with only the nonce it returns.' });
          const first = await generation(target, chatId, messages, 'tool-request', sample);
          if (first.calls.length !== 1 || first.calls[0].function.name !== 'lookup_nonce'
            || JSON.parse(first.calls[0].function.arguments).label !== 'probe') throw new Error('Tool trial did not call the required tool exactly once.');
          const nonce = randomUUID();
          messages.push({ role: 'tool', tool_call_id: first.calls[0].id, content: nonce });
          const second = await generation(target, chatId, messages, 'tool-result', sample);
          if (second.calls.length || !second.content.includes(nonce)) throw new Error('Tool trial did not return the actual nonce.');
          if (restart && target.kind) {
            await disposeCliSessions(session => session.chatId === chatId);
            messages.push({ role: 'user', content: prose });
            const resumed = await generation(target, chatId, messages, 'restarted-prose', sample);
            if (resumed.calls.length || !resumed.content.trim()) throw new Error('Restart trial did not return text only.');
          }
        } catch (error) {
          trialError = error.message;
          console.error(JSON.stringify({ provider: target.providerId, sample, trialError: error.message }));
        } finally {
          results.trials.push({ provider: target.providerId, model: target.model, sample, status: trialError ? 'failed' : 'passed', error: trialError });
          await save();
          await disposeCliSessions(session => session.chatId === chatId);
          if (target.kind) await removeCliCache(cliCacheDir(target.providerId, chatId));
        }
      }
    }
    return results;
  } finally {
    results.finishedAt = new Date().toISOString(); await save();
    await disposeCliSessions();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (!args.includes('--account')) throw new Error('This benchmark spends account inference. Pass --account explicitly.');
  const value = flag => args[args.indexOf(flag) + 1];
  const targets = args.includes('--targets') ? JSON.parse(value('--targets')) : [
    { providerId: 'codex-cli', model: 'gpt-6-luna', kind: 'codex' },
    { providerId: 'opencode-go', model: 'gpt-6-luna' },
    { providerId: 'claude-code-cli', model: 'claude-sonnet-5', kind: 'claude' },
    { providerId: 'opencode-zen', model: 'claude-sonnet-5' },
  ];
  const samples = args.includes('--samples') ? Number(value('--samples')) : 3;
  if (!Number.isInteger(samples) || samples < 1 || samples > 10) throw new Error('Samples must be 1–10.');
  await benchmarkChatLatency({ targets, samples, restart: args.includes('--restart'), output: args.includes('--output') ? value('--output') : undefined });
}
