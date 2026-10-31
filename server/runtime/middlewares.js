import { createAgentPacksMiddleware } from '../agent-packs/routes.js';
import { createActivityMiddleware } from '../activity/middleware.js';
import { createChatTurnRegistry, createChatTurnsMiddleware } from '../chat-turns/middleware.js';
import { createChatLiveBroker, createChatLiveMiddleware } from '../chat-turns/live.js';
import { ChatContractError } from '../chats/contracts.js';
import { createChatMiddleware } from '../chats/middleware.js';
import { createChatRepository } from '../chats/repository.js';
import { useJsonSessionsStore } from '../config/sessions-repo.js';
import { createProductionChatRuntime, getProductionChatRuntime, peekProductionChatRuntime, publishProductionChatRuntime, setProductionChatRuntimeFactory } from '../chats/runtime.js';
import { installChatDelegation } from '../chats/delegation.js';
import { installLegacyChatImporter } from '../chats/legacy-import.js';
import { installChatWorkspaces } from '../chats/workspace-runtime.js';
import { installChatTools } from '../chats/tools.js';
import { createAgentChatToolsMiddleware } from '../chats/agent-tools-middleware.js';
import { createLazyPersistentSubAgentEffector } from '../chats/task-bridge.js';
import { peekEngine } from '../orchestrator/engine.js';
import { AGENTS_NAMESPACE } from '../sub-agents/derive.js';
import { loadState as loadAgentState } from '../sub-agents/journal.js';
import { createBenchmarkWorkspaceMiddleware } from '../benchmark-workspace/middleware.js';
import { createChatsWorkspaceMiddleware } from '../chats-workspace/middleware.js';
import { createBenchmarksMiddleware } from '../benchmarks/middleware.js';
import { createCompareMiddleware } from '../compare/middleware.js';
import { createBrowserAllowlistMiddleware } from '../browser-allowlist-middleware.js';
import { createBrowserScreenshotMiddleware } from '../browser-screenshot-middleware.js';
import { createSettingsMiddleware } from '../settings/middleware.js';
import { createConfigMiddleware } from '../config/middleware.js';
import { createEvalsMiddleware } from '../evals/middleware.js';
import { createGenerationsMiddleware } from '../generations/routes.js';
import { createResearchMiddleware } from '../research/routes.js';
import { createLspMiddleware } from '../lsp/middleware.js';
import { createGodotMiddleware } from '../godot/middleware.js';
import { createMcpMiddleware } from '../mcp/middleware.js';
import { createMcpHubMiddleware } from '../mcp-hub/middleware.js';
import { createServersMiddleware } from '../servers/index.js';
import { createMemoryMiddleware } from '../memory/middleware.js';
import { createBrainMiddleware } from '../brain/middleware.js';
import { createProductWikiMiddleware } from '../product-wiki/middleware.js';
import { createPreviewMiddleware } from '../preview/middleware.js';
import { createPreviewAccessMiddleware } from '../preview/isolated-host.js';
import { createDesignAnnotationsMiddleware } from '../design/annotations-routes.js';
import { createSourceMapMiddleware } from '../design/source-map-routes.js';
import { createProfilesMiddleware } from '../profiles/middleware.js';
import { createPromptConfigsMiddleware } from '../prompt-configs/middleware.js';
import { createProviderMiddleware } from '../providers/routes.js';
import { createSttMiddleware } from '../stt/middleware.js';
import { createTtsMiddleware } from '../tts/middleware.js';
import { createVoiceRuntimeMiddleware } from '../voice/routes.js';
import { createSkillsMiddleware } from '../skills/middleware.js';
import { createPluginsMiddleware } from '../tools/middleware.js';
import { createTerminalMiddleware } from '../terminal/middleware.js';
import { createSystemMiddleware } from '../system/middleware.js';
import { createModelsMiddleware } from '../models/index.js';
import { createSchedulerMiddleware } from '../scheduler/middleware.js';
import { createReefMiddleware } from '../reef/middleware.js';
import { createBackupMiddleware } from '../backup/middleware.js';
import { createWebhooksMiddleware } from '../webhooks/middleware.js';
import { createWorkspaceMiddleware } from '../workspace/middleware.js';
import { createGitMiddleware } from '../git/middleware.js';
import { createWorktreeMiddleware } from '../worktree/middleware.js';
import { createWorkAgentsMiddleware } from '../work-agents/routes.js';
import { createOrchestrateMiddleware } from '../orchestrate/middleware.js';
import {
  createBoardsMiddleware,
  setEffectorFactory,
} from '../orchestrator/middleware.js';
import {
  bootSuperPlanRuntime,
  createSuperPlanMiddleware,
  setSuperPlanEffectorFactory,
  createProductionSuperPlanEffector,
} from '../super-plan/middleware.js';
import { armBoardResumeGate } from '../orchestrator/resume-gate.js';
import {
  cancelOrphanedRunnerGenerations,
  createRunnerEffector,
} from '../orchestrator/effector-runner.js';
import {
  createAgentsMiddleware,
  setAgentsEffectorFactory,
  getAgentsEngine,
  configurePersistentAgentSpawner,
  configureAgentRecoveryGate,
} from '../sub-agents/middleware.js';
import {
  cancelOrphanedSubAgentGenerations,
  createSubAgentEffector,
} from '../sub-agents/effector-runner.js';
import { bootAgentsRuntime } from '../sub-agents/runtime.js';
import { createBoardTestingMiddleware } from '../orchestrate/board-testing/middleware.js';
import { createToolsMiddleware } from './tools-middleware.js';
import { createAgentBrowserMiddleware } from '../browser-agent-api.js';
import { createAuthMiddleware, createRemoteResponseHeadersMiddleware } from './auth-middleware.js';
import { createRemoteMiddleware } from '../remote/middleware.js';
import { createWorkspaceScopeMiddleware } from './workspace-scope-middleware.js';
import { createAuthRoutesMiddleware } from '../auth/routes.js';
import { createDiagnosticsMiddleware } from '../diagnostics/middleware.js';
import { createIssueAttachmentsMiddleware } from '../issues/attachments-routes.js';
import { installDiagnosticsProcessHandlers } from '../diagnostics/process-handlers.js';
import { getEffectiveWorkspaceRoot } from './path-access.js';

/**
 * @param {import('connect').Connect.Server} connectApp
 * @param {{ resolveSafePath: (userPath: string, options?: { write?: boolean }) => string, runWithPathAccess: <T>(fn: () => Promise<T>) => Promise<T> }} deps
 */
export function applyMinnowMiddlewares(connectApp, { resolveSafePath, runWithPathAccess }) {
  installDiagnosticsProcessHandlers();
  cancelOrphanedRunnerGenerations();
  setEffectorFactory((boardId) => createRunnerEffector({ boardId }));
  armBoardResumeGate();
  void import('../orchestrator/middleware.js').then(({ bootBoardRuntime }) => bootBoardRuntime()).catch(error => console.error('[orchestrator] boot recovery failed:', error.message));
  cancelOrphanedSubAgentGenerations();
  setAgentsEffectorFactory((parentChatId) => {
    const legacyEffector = createSubAgentEffector({ parentChatId });
    return createLazyPersistentSubAgentEffector({ legacyEffector, getRuntime: async () => peekProductionChatRuntime() ?? getProductionChatRuntime(),
      getState: () => peekEngine(parentChatId, AGENTS_NAMESPACE)?.getState() ?? loadAgentState(parentChatId),
    });
  });
  configureAgentRecoveryGate(useJsonSessionsStore() ? null : () => getProductionChatRuntime());
  if (useJsonSessionsStore()) void bootAgentsRuntime();
  // Super Plan: the headless stages (research/review/polish) run in-process;
  // interview/draft are delegated to the renderer through a lease
  // (`effector-delegated.js`) that the claim route hands out. Boot re-arms
  // every non-terminal run so an open stage replans itself after a restart.
  setSuperPlanEffectorFactory(createProductionSuperPlanEffector);
  void bootSuperPlanRuntime();
  connectApp.use(createRemoteResponseHeadersMiddleware());
  connectApp.use(createAuthMiddleware());
  // Authenticate first, then scope: every downstream handler runs inside the
  // requesting view's workspace.
  connectApp.use(createWorkspaceScopeMiddleware());
  connectApp.use(createPreviewAccessMiddleware());
  connectApp.use(createMcpHubMiddleware());
  connectApp.use(createActivityMiddleware());
  const protectedChat = chatId => {
    try { return createChatRepository().getChat(chatId).chatCommandVersion === 1; } catch { return false; }
  };
  const chatTurns = createChatTurnRegistry({
    isServerOwned: protectedChat,
    extraTurns: () => peekProductionChatRuntime()?.listTurns() ?? [],
    captureCancellationEpoch(chatId) { try { return createChatRepository().getCancellationEpoch(chatId); } catch { return undefined; } },
    canClaim(chatId, ownerId) {
      if (useJsonSessionsStore()) return true;
      try {
        const lease = createChatRepository().getLease(chatId);
        return !lease || lease.state !== 'active' || (lease.ownerId === ownerId && lease.expiresAt > Date.now());
      } catch { return false; }
    },
    onRenew(chatId, ownerId) {
      try { peekProductionChatRuntime()?.renewLegacy(chatId, ownerId); return true; } catch { return false; }
    },
    onRelease(chatId, ownerId) { peekProductionChatRuntime()?.releaseLegacy(chatId, ownerId); },
  });
  const liveBroker = createChatLiveBroker({ turns: chatTurns, isManagedChat: protectedChat });
  setProductionChatRuntimeFactory(async () => {
    const runtime = createProductionChatRuntime({ turns: chatTurns,
      stopExternalOwner: async ({ chatId, owner, commandId }) => {
        const matches = () => chatTurns.listLegacy().some(row => row.chatId === chatId && row.ownerId === owner.ownerId);
        if (!matches()) return { stopRequested: false };
        try {
          const admitted = await liveBroker.submit({ id: commandId, chatId, action: 'stop', expectedOwnerId: owner.ownerId }, 'host');
          const result = admitted.pending ? await liveBroker.waitResult(admitted.id, 'host') : admitted;
          if (result.ok !== true) throw new Error('Original owner did not accept Stop');
          return { stopRequested: true };
        } catch {
          if (!matches()) return { stopRequested: false };
          throw new ChatContractError('capability_unavailable', 'The original renderer has not confirmed Stop. Its queued Stop is retained.', { retryable: true });
        }
      },
    });
    publishProductionChatRuntime(runtime);
    installChatWorkspaces(runtime);
    installLegacyChatImporter(runtime);
    installChatTools(runtime);
    installChatDelegation(runtime, { getEngine: parentChatId => getAgentsEngine(parentChatId, { skipRecoveryGate: true }),
      onChange: chatId => runtime.presentation.changed(chatId),
      cancelTree: input => {
        if (!runtime.taskDelivery) throw new ChatContractError('capability_unavailable', 'Task cancellation recovery is not available');
        return runtime.taskDelivery.cancelTree(input);
      },
      resolveWorkspace: async input => {
        if (!runtime.workspaceResolver) {
          if (input.strategy.kind !== 'shared') throw new ChatContractError('capability_unavailable', 'Checkout isolation is unavailable');
          return { workspacePath: input.target.scope.canonicalKey, scope: input.target.scope, registry: input.target.registry };
        }
        const result = await runtime.workspaceResolver.resolve({ ...input, sourceTarget: input.target });
        const project = await runtime.context.project(input.target.scope.canonicalKey);
        return { ...result.chatPatch, scope: result.scope, registry: project.registry, binding: result.binding };
      },
    });
    await runtime.start();
    void bootAgentsRuntime().catch(error => console.error('[agents] boot recovery failed:', error.message));
    return runtime;
  });
  configurePersistentAgentSpawner(async (req, body, executionContext = {}) => {
    if (req.minnowAuth?.kind !== 'host') throw new ChatContractError('caller_denied', 'Only the owning computer execution may delegate agents');
    const allowed = new Set(['conversationVersion', 'parentChatId', 'ownerId', 'parentToolCallId', 'type', 'task', 'title', 'target', 'workspace_strategy', 'workspace_id', 'client_request_id', 'wait', 'providerId', 'modelId', 'category', 'board_task_id']);
    if (Object.keys(body).some(key => !allowed.has(key))) throw new ChatContractError('invalid_request', 'Unsupported persistent delegation input');
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(body.parentChatId ?? '') || !/^[A-Za-z0-9_-]{1,160}$/.test(body.ownerId ?? '')) throw new ChatContractError('caller_not_active', 'A bound parent execution is required');
    const runtime = await getProductionChatRuntime();
    const { caller } = await runtime.legacyCaller({ chatId: body.parentChatId, ownerId: body.ownerId });
    const { conversationVersion: _version, parentChatId: _parent, ownerId: _owner, parentToolCallId, ...input } = body;
    const receipt = await runtime.delegation.spawn(caller, input, { toolCallId: parentToolCallId, signal: executionContext.signal });
    return { status: 201, body: { ok: true, ...receipt } };
  });
  connectApp.use(createChatTurnsMiddleware(chatTurns));
  connectApp.use(createAgentChatToolsMiddleware({ getRuntime: getProductionChatRuntime }));
  connectApp.use(createChatMiddleware({ getRuntime: getProductionChatRuntime }));
  connectApp.use(createChatLiveMiddleware(chatTurns, { broker: liveBroker }));
  if (!useJsonSessionsStore()) void getProductionChatRuntime().catch(error => console.error('[chats] boot recovery failed:', error.message));
  connectApp.use(createAuthRoutesMiddleware());
  connectApp.use(createRemoteMiddleware());
  connectApp.use(createDiagnosticsMiddleware());
  connectApp.use(createConfigMiddleware());
  connectApp.use(createIssueAttachmentsMiddleware());
  connectApp.use(createSettingsMiddleware());
  connectApp.use(createBenchmarksMiddleware());
  connectApp.use(createCompareMiddleware());
  connectApp.use(createEvalsMiddleware());
  connectApp.use(createWorkspaceMiddleware());
  connectApp.use(createGodotMiddleware());
  connectApp.use(createGitMiddleware());
  connectApp.use(createWorktreeMiddleware());
  connectApp.use(createOrchestrateMiddleware());
  connectApp.use(createBoardsMiddleware());
  connectApp.use(createSuperPlanMiddleware());
  connectApp.use(createAgentsMiddleware());
  connectApp.use(createBoardTestingMiddleware());
  connectApp.use(createChatsWorkspaceMiddleware());
  connectApp.use(createBenchmarkWorkspaceMiddleware());
  connectApp.use(createSystemMiddleware());
  connectApp.use(createModelsMiddleware());
  connectApp.use(createSchedulerMiddleware());
  connectApp.use(createReefMiddleware());
  connectApp.use(createBackupMiddleware());
  connectApp.use(
    createPreviewMiddleware({
      resolveSafePath,
      runWithPathAccess,
    }),
  );
  connectApp.use(
    createDesignAnnotationsMiddleware({
      resolveSafePath,
      runWithPathAccess,
    }),
  );
  connectApp.use(
    createSourceMapMiddleware({
      resolveSafePath,
      runWithPathAccess,
    }),
  );
  connectApp.use(createMemoryMiddleware());
  connectApp.use(createBrainMiddleware());
  connectApp.use(createProductWikiMiddleware());
  connectApp.use(createWebhooksMiddleware());
  connectApp.use(createLspMiddleware(() => getEffectiveWorkspaceRoot()));
  connectApp.use(createMcpMiddleware());
  connectApp.use(createServersMiddleware());
  connectApp.use(createPluginsMiddleware());
  connectApp.use(createPromptConfigsMiddleware());
  connectApp.use(createProfilesMiddleware());
  connectApp.use(createProviderMiddleware());
  connectApp.use(createSttMiddleware());
  connectApp.use(createTtsMiddleware());
  connectApp.use(createVoiceRuntimeMiddleware());
  connectApp.use(createGenerationsMiddleware());
  connectApp.use(createResearchMiddleware());
  connectApp.use(createWorkAgentsMiddleware());
  connectApp.use(createAgentPacksMiddleware());
  connectApp.use(createBrowserScreenshotMiddleware());
  connectApp.use(createBrowserAllowlistMiddleware());
  connectApp.use(createAgentBrowserMiddleware());
  connectApp.use(createToolsMiddleware());
  connectApp.use(createSkillsMiddleware());
  connectApp.use(createTerminalMiddleware(() => getEffectiveWorkspaceRoot()));
}
