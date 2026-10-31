import { ChatContractError } from './contracts.js';
import { createChatWorkspaceResolver } from './workspace.js';
import { createChatWorkspaceRepository } from './workspace-repository.js';

/** Bind protected allocations to the same project context used for all admissions. */
export function installChatWorkspaces(runtime, options = {}) {
  const assertActive = caller => {
    if (!runtime.isExecutionCallerActive(caller)) throw new ChatContractError('caller_not_active', 'The allocating execution is no longer active');
  };
  const resolver = createChatWorkspaceResolver({
    ...options,
    workspaceRepository: options.workspaceRepository ?? createChatWorkspaceRepository({ db: runtime.repository.getDatabase() }),
    refreshSourceTarget: async (caller, chatId) => {
      assertActive(caller);
      const target = await runtime.context.resolveTarget(chatId);
      assertActive(caller);
      return target;
    },
  });
  runtime.workspaceResolver = resolver;
  runtime.context.setWorkspaceEdgesLoader(project => resolver.listVerifiedEdges(project));
  return resolver;
}
