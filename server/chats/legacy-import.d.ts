import type { ChatCaller } from './caller';
import type { ChatContext } from './context';
import type { ChatRepository, ChatShell } from './repository';
import type { captureChatProfile } from './preparation';
import type { resolveAgentModelSelection } from './model-selection';
export interface LegacyChatSource { runId: string; type: string; task: string; source: 'attempt_audit' | 'saved_snapshot'; messages: unknown[]; summary?: string; partial: true; capped: boolean; truncated: boolean; attemptId?: string | null; childChatId?: string; }
export interface LegacyChatImportReceipt { childChatId: string; sourceParentChatId: string; sourceRunId: string; revision: number; link: string; context: { partial: true; source: LegacyChatSource['source']; capped: boolean; truncated: boolean }; replayed: boolean; }
export interface LegacyChatImporter { continue(caller: ChatCaller, input: { parentChatId: string; runId: string; clientRequestId: string; title?: string }): Promise<LegacyChatImportReceipt>; }
export interface LegacyChatImporterOptions { repository: ChatRepository; context: Pick<ChatContext, 'resolveTarget'>; feature?(): { creationEnabled: boolean }; loadSource?(parent: ChatShell, runId: string): Promise<LegacyChatSource>; loadConfig?(): Promise<any>; resolveModelSelection?: typeof resolveAgentModelSelection; captureProfile?: typeof captureChatProfile; now?(): number; onChange?(chatId: string): void; }
export function readLegacyChatSource(parent: ChatShell, runId: string): Promise<LegacyChatSource>;
export function legacyContextNote(source: LegacyChatSource, parentId: string): { content: string; partial: true; source: LegacyChatSource['source']; capped: boolean; truncated: boolean };
export function createLegacyChatImporter(options: LegacyChatImporterOptions): LegacyChatImporter;
export function installLegacyChatImporter(runtime: any, options?: Partial<LegacyChatImporterOptions>): LegacyChatImporter;
