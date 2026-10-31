import { ChatContractError } from './contracts.js';

export const CHAT_POLICY_VERSION: 1;
export type ChatPolicyMode = 'general' | 'build' | 'plan' | 'debug' | 'orchestrate' | 'onboarding';
export type ChatToolPermission = 'off' | 'ask' | 'full';
export type ChatToolEffect = 'read' | 'file-write' | 'git-write' | 'shell' | 'external-write' | 'unknown';
export type ChatPolicyCapability = 'chat.read' | 'chat.send' | 'chat.stop' | 'agent.spawn' | 'request.respond' | 'execution.host';
export type ChatFileWriteScope = 'none' | 'plans' | 'workspace' | 'full';
export type ChatPolicyErrorReason =
  | 'invalid_policy' | 'invalid_caller' | 'untrusted_caller' | 'execution_caller_required'
  | 'project_scope_denied' | 'cross_project_denied' | 'capability_denied' | 'broader_target_denied'
  | 'tool_denied' | 'plan_write_denied' | 'approval_required' | 'self_target_denied';

export class ChatPolicyError extends ChatContractError {
  constructor(reason: ChatPolicyErrorReason, message: string, details?: Record<string, unknown>);
  readonly reason: ChatPolicyErrorReason;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ChatPolicyInput {
  version?: 1;
  modeId: ChatPolicyMode | 'super-plan' | 'desktop' | 'email';
  toolPermissions?: Readonly<Record<string, ChatToolPermission>>;
  /** Trusted catalog annotations; unknown external effects fail closed in restricted profiles. */
  toolEffects?: Readonly<Record<string, ChatToolEffect>>;
  workspaceIds?: readonly string[];
  filesystemAccess?: 'workspace' | 'full';
  fileWriteScope?: ChatFileWriteScope;
  shellSandboxMode?: 'off' | 'prefer' | 'require';
  capabilities?: readonly ChatPolicyCapability[];
}

export interface ChatPolicySnapshot {
  readonly version: 1;
  readonly modeId: ChatPolicyMode;
  readonly toolPermissions: Readonly<Record<string, ChatToolPermission>>;
  readonly toolEffects: Readonly<Record<string, ChatToolEffect>>;
  readonly workspaceIds: readonly string[];
  readonly filesystemAccess: 'workspace' | 'full';
  readonly fileWriteScope: ChatFileWriteScope;
  readonly shellSandboxMode: 'off' | 'prefer' | 'require';
  readonly capabilities: readonly ChatPolicyCapability[];
}

/** Build from trusted resolved permissions or a server-loaded stored profile, never model authority claims. */
export function createChatPolicy(input: ChatPolicyInput): ChatPolicySnapshot;
export function assertChatPolicy(policy: unknown): ChatPolicySnapshot;
export function intersectChatPolicies(...inputs: readonly ChatPolicySnapshot[]): ChatPolicySnapshot;
export function compareChatPolicies(ceiling: ChatPolicySnapshot, target: ChatPolicySnapshot): {
  readonly allowed: boolean;
  readonly violations: readonly string[];
};
export function assertChatPolicyWithinCeiling(target: ChatPolicySnapshot, ceiling: ChatPolicySnapshot): ChatPolicySnapshot;
export function assertChatToolAllowed(
  capturedPolicy: ChatPolicySnapshot,
  name: string,
  args: Record<string, unknown>,
  options: { currentPolicy: ChatPolicySnapshot; approvalGranted?: boolean },
): { readonly toolName: string; readonly permission: ChatToolPermission; readonly policy: ChatPolicySnapshot };
