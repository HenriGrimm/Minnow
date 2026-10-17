import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createToolExposure } from '../../server/runner/tool-exposure.js';
import { estimateToolsTokens, estimateHistoryTokens } from '../../server/runner/token-estimate-core.js';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';

const tools = [
  { type: 'function' as const, function: { name: 'git_log', description: 'Repository history', parameters: { type: 'object', properties: {} } } },
  { type: 'function' as const, function: { name: 'mcp__mail__send', description: 'Email '.repeat(10_000), parameters: { type: 'object', properties: {} } } },
];
let lazyTools = true;
let apiKind = 'agent-cli-v1';
let toolEpoch = 0;
let composes = 0;
const providerRequests: Array<string | undefined> = [];
mock.module('../../src/providers/store.ts', { namedExports: {
  resolveProvider: async (id?: string) => { providerRequests.push(id); return { id: id ?? 'default', apiKind }; },
} });
mock.module('../../src/models/model-select-library.ts', { namedExports: { LIBRARY_MODEL_PROVIDER_ID: 'minnow-library' } });
mock.module('../../src/tools/config.ts', { namedExports: { loadToolConfig: () => ({ lazyTools }) } });
mock.module('../../src/chat/outbound-estimate-epochs.ts', { namedExports: { getToolConfigEpoch: () => toolEpoch, getPromptConfigEpoch: () => 0 } });
mock.module('../../src/agents/resolve-work-agent.ts', { namedExports: { resolveActiveWorkAgent: () => null, resolveActiveWorkAgentId: () => null } });
mock.module('../../src/agents/ui-designer/runner.ts', { namedExports: { applyUiDesignerToolFilter: (defs: unknown) => defs, prepareUiDesignerTurn: () => ({}) } });
mock.module('../../src/config/user-rules.ts', { namedExports: { getUserRulesPayloadForSend: () => '', loadUserRules: async () => ({}) } });
mock.module('../../src/api/models.ts', { namedExports: { getModelRowForSelectOrCanonicalId: () => null } });
mock.module('../../src/state/sessions.ts', { namedExports: { getActiveChat: () => chat } });
mock.module('../../src/tools/client.ts', { namedExports: { getEnabledToolDefinitionsForMode: () => tools } });
mock.module('../../src/tools/api-system-messages.ts', { namedExports: { pushOutboundSystemMessages: () => {} } });
mock.module('../../src/chat/context-budget.ts', { namedExports: {
  agentContextBudgetFromWorkAgent: () => ({}), DEFAULT_CONTEXT_ENFORCEMENT_POLICY: 'compact',
  estimateApiMessageTokens: () => 0, estimateApiMessagesTokens: () => 0,
  resolveContextBudget: () => ({ effectiveLimit: null }), SAFETY_MARGIN: 0.9,
} });
mock.module('../../src/chat/context/estimate-calibration.ts', { namedExports: { contextCalibratedMessageLimit: () => null } });
mock.module('../../src/chat/context/apply-policy.ts', { namedExports: { estimateContextPolicyTrim: () => ({}) } });
mock.module('../../src/chat/context/chat-context-budget.ts', { namedExports: { resolveChatContextBudget: () => ({}) } });
mock.module('../../src/chat/context/injection-notice.ts', { namedExports: { isUiOnlyTranscriptMessage: () => false } });
mock.module('../../src/chat/prompts/compose-context.ts', { namedExports: { resolveExpertContextForSend: async () => ({}), buildComposeContext: async () => ({}) } });
mock.module('../../src/chat/prompts/first-turn-injection.ts', { namedExports: { shouldRunFirstTurnInjections: () => true } });
mock.module('../../src/chat/context/injection-replay.ts', { namedExports: { latestInjectionBodies: () => ({}) } });
mock.module('../../src/chat/prompts/prompt-composer.ts', { namedExports: {
  composeSystemPrompt: () => { composes++; return 'System instructions'; },
  isBrainNotesPartEnabled: () => false, isCodeMapPartEnabled: () => false, isContextDocumentsPartEnabled: () => false,
} });
mock.module('../../src/chat/context/reasoning-replay-config.ts', { namedExports: { fetchReplayPriorReasoningEnabled: async () => false } });
const { resolveOutboundPromptEstimate } = await import('../../src/chat/prompts/token-estimate.ts');
const chat = { id: 'estimate', providerId: 'cli', modelId: 'same-model', modeId: 'build', history: [] } as any;

test('outbound context estimate mirrors CLI exposure and invalidates its cache on provider changes', async () => {
  const estimate = () => resolveOutboundPromptEstimate({ chat, modelId: 'same-model' });
  const expected = () => estimateToolsTokens(createToolExposure(tools, { apiKind, lazyTools }).tools);
  assert.equal((await estimate()).tools, expected());
  assert.equal((await estimate()).tools, expected());
  assert.equal(composes, 1, 'provider lookup preserves static compose caching');
  const content = createToolExposure(tools, { apiKind }).cliMcpTools!.search({ query: 'mcp__mail__send', limit: 1 });
  chat.history.push({ role: 'tool', tool_call_id: 'schema', content });
  const discovered = await estimate();
  assert.equal(discovered.tools, expected());
  assert.equal(discovered.history, estimateHistoryTokens(chat.history));

  apiKind = 'openai-v1';
  assert.equal((await estimate()).tools, expected());
  assert.equal(composes, 2, 'changing provider kind invalidates the cached tool reserve');
  lazyTools = false;
  toolEpoch++;
  assert.equal((await estimate()).tools, expected());
  assert.ok(expected() > discovered.tools * 10, 'API opt-out still includes full MCP schemas');
  apiKind = 'agent-cli-v1';
  assert.equal((await estimate()).tools, expected(), 'CLI MCP discovery applies with API lazy loading disabled');

  await resolveOutboundPromptEstimate({ chat, modelId: encodeModelSelectKey('selected-cli', 'same-model') });
  assert.equal(providerRequests.at(-1), 'selected-cli', 'model picker provider overrides the preceding chat binding');
  chat.providerId = 'minnow-library';
  const requests = providerRequests.length;
  assert.equal((await estimate()).tools, estimateToolsTokens(tools));
  assert.equal(providerRequests.length, requests, 'the synthetic local-library provider never falls back to a CLI');
});
