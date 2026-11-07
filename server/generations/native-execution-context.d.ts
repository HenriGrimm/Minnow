export interface NativeExecutionMeta {
  chatId: string;
  providerId: string;
  generationId: string;
  threadId?: string | null;
  turnId?: string | null;
  workspace: string;
  mode: 'read-only' | 'workspace-write';
  policyFingerprint: string;
  [key: string]: unknown;
}
export interface NativeExecutionContext {
  readonly policy: Readonly<{ version: 1; workspace: string; mode: 'read-only' | 'workspace-write'; networkAccess: 'off'; fingerprint: string }>;
  readonly signal: AbortSignal;
  projectMessages?(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>>;
  runTurn<T>(meta: NativeExecutionMeta, operation: () => Promise<T>): Promise<T>;
  assertCurrent(meta: NativeExecutionMeta): Promise<void>;
  record(event: NativeExecutionMeta): Promise<unknown>;
  approve(request: NativeExecutionMeta): Promise<'accept' | 'decline' | 'cancel'>;
  dispose(): void;
}
export function createNativeExecutionContext<T extends NativeExecutionContext>(execution: T,
  identity: { chatId: string; providerId: string; modelId: string }): T;
export function assertNativeExecutionContext(execution: unknown, identity: {
  chatId?: string | null; providerId: string; modelId: string; body?: unknown; fallbackRole?: string | null;
}): NativeExecutionContext;
export function bindNativeExecutionContext(state: object, execution: NativeExecutionContext): void;
export function getNativeExecutionContext(state: object): NativeExecutionContext | null;
export function bindMinnowOnlyExecution(state: object): void;
export function isMinnowOnlyExecution(state: object): boolean;
