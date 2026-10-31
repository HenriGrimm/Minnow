import type { ChatPolicySnapshot } from './policy.js';

export interface RegisteredChatWorkspace {
  projectId: string;
  workspaceId: string;
  /** Supplied by the existing realpath/platform canonicalizer, not a lexical path prefix. */
  canonicalKey: string;
  aliases?: readonly string[];
  revoked?: boolean;
}
export interface ChatProjectRegistry {
  readonly entries: readonly Readonly<RegisteredChatWorkspace & { aliases: readonly string[]; revoked: boolean }>[];
  readonly derivedEdges: readonly Readonly<{ sourceWorkspaceId: string; targetWorkspaceId: string }>[];
}
export interface ChatProjectScope {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly canonicalKey: string;
}
export type ChatCallerActor = 'human' | 'agent' | 'system';
export type ChatCallerIngress = 'renderer' | 'server' | 'cli' | 'scheduler' | 'tool' | 'device';
export interface ChatCallerInput {
  actor: ChatCallerActor;
  ingress: ChatCallerIngress;
  chatId: string;
  executionId?: string;
  attemptId?: string;
  executionActive?: boolean;
  scope: ChatProjectScope;
  policy: ChatPolicySnapshot;
}
export interface ChatCaller extends Readonly<ChatCallerInput> {
  readonly executionActive: boolean;
}
export type ChatTargetOperation = 'read' | 'send' | 'stop' | 'spawn' | 'respond';

/** All factories are server adapter boundaries; do not pass decoded request/tool objects directly. */
export interface DerivedChatWorkspaceEdge {
  projectId: string; sourceWorkspaceId: string; targetWorkspaceId: string; sourceCanonicalPath: string; targetCanonicalPath: string;
}
export function createChatProjectRegistry(records: readonly RegisteredChatWorkspace[], derivedEdges?: readonly DerivedChatWorkspaceEdge[]): ChatProjectRegistry;
export function projectChatPolicyToWorkspace(policy: ChatPolicySnapshot, scope: ChatProjectScope, registry: ChatProjectRegistry): ChatPolicySnapshot;
export function resolveProjectScope(registry: ChatProjectRegistry, input: { projectId: string; workspaceKey: string }): ChatProjectScope;
export function createChatCaller(input: ChatCallerInput): ChatCaller;
export function assertCaller(caller: unknown): ChatCaller;
export function assertExecutionCaller(caller: unknown): ChatCaller;
export function assertCallerCanTarget(
  caller: ChatCaller,
  target: { chatId?: string; scope: ChatProjectScope; policy?: ChatPolicySnapshot },
  options: { operation: ChatTargetOperation; currentPolicy: ChatPolicySnapshot; registry: ChatProjectRegistry },
): { readonly caller: ChatCaller; readonly scope: ChatProjectScope; readonly policy: ChatPolicySnapshot };
