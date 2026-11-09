export type PermissionLevel = 'manual' | 'auto' | 'full';
export type TurnClamp = 'read-only' | 'plans';
export type ActionKind =
  | 'none' | 'read' | 'edit' | 'shell' | 'git' | 'app' | 'network' | 'browser'
  | 'integration' | 'settings' | 'unknown';
export type ActionRisk = 'low' | 'elevated' | 'high';

export interface ActionGrant { key: string; label: string }

export interface ClassifiedAction {
  tool: string;
  kind: ActionKind;
  mutates: boolean;
  external: boolean;
  risk: ActionRisk;
  reasons: string[];
  resources: string[];
  planScoped?: boolean;
  clampedShellRead?: boolean;
  floor: boolean;
  title: string;
  detail: string;
  grant: ActionGrant | null;
}

export interface PermissionDecision { decision: 'allow' | 'ask' | 'deny'; reason: string }

export const PERMISSION_LEVELS: readonly PermissionLevel[];
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel;
export const PERMISSION_LEVEL_META: Readonly<Record<PermissionLevel, { label: string; description: string; icon: string }>>;
export const TURN_CLAMPS: readonly TurnClamp[];

export function isPermissionLevel(value: unknown): value is PermissionLevel;
export function normalizePermissionLevel(value: unknown, fallback?: PermissionLevel): PermissionLevel;
export function minPermissionLevel(...levels: unknown[]): PermissionLevel;
export function normalizeTurnClamp(value: unknown): TurnClamp | null;
export function permissionLevelPromptLine(level: unknown): string;
export function turnClampPromptLine(clamp: unknown): string;
export function permissionPromptBlock(level: unknown, clamp: unknown): string;
export function resolveActionPath(userPath: string, workspaceRoot: string, homeDir?: string): string;
export function splitShellSegments(command: string): Array<{ text: string; pipe: boolean }>;
export function classifyShellCommand(
  command: string,
  options?: { workspaceRoot?: string; homeDir?: string },
): { readOnly: boolean; risk: ActionRisk; reasons: string[]; external: boolean; prefix: string };
export function classifyToolCall(
  name: string,
  args?: Record<string, unknown>,
  options?: { workspaceRoots?: string[]; homeDir?: string; toolHint?: 'read' | 'write' | 'destructive' | null },
): ClassifiedAction;
export function decidePermission(
  level: PermissionLevel,
  action: ClassifiedAction,
  context?: { grants?: Array<string | { key: string }>; clamp?: TurnClamp | null },
): PermissionDecision;
