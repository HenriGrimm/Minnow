/** Workspace context shown in the approval dialog. */
export type ToolApprovalWorkspace =
  | { label: string; path: string }
  | { hint: string };

/** Payload passed from the permission gate through the queue to the modal. */
export interface ToolApprovalRequest {
  /** Resolved tool id (same as the catalog / API function name). */
  toolName: string;
  title: string;
  description?: string;
  argsJson: string;
  workspace?: ToolApprovalWorkspace;
  /** Shown when paths leave the workspace under workspace FS mode. */
  pathWarning?: string;
  subAgentType?: string;
  workAgentId?: string | null;
  signal?: AbortSignal;
}
