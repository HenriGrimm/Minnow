/** Commands delivered only to the shell window owning a workspace. */
export interface CodeWindowCommand {
  /** Assigned by main so workflow links return to the originating issue store. */
  requestId?: string;
  kind: 'seed' | 'file' | 'chat' | 'board' | 'activity';
  workspacePath: string;
  issueId?: string;
  /** Snapshot rendered as a ticket in the seeded user message. */
  issue?: import('../src/types.js').IssueMessageSnapshot;
  modeId?: string;
  seed?: string;
  path?: string;
  chatId?: string;
  boardGroupId?: string;
  runId?: string;
  codeRefs?: Array<{ path: string; startLine?: number; endLine?: number; text?: string }>;
  /** Apply after the seeded chat is created, before auto-send. */
  runTarget?:
    | { kind: 'local' }
    | { kind: 'attach'; path: string; branch?: string }
    | { kind: 'create'; name: string; startPoint: string; checkoutExisting: boolean };
}
