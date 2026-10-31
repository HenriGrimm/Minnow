/**
 * A process-local proof that the authenticated server host channel admitted
 * this exact call. JSON, model arguments and storage cannot recreate it.
 * Only the host capability receiver mints it, after persisting its started
 * marker. It suppresses one duplicate permission Ask, never other guards.
 */
declare const admissionBrand: unique symbol;
export interface ServerToolAdmission { readonly [admissionBrand]: true }
export interface ServerAdmissionContext {
  chatId?: string; executionId?: string; toolCallId?: string; modeId?: string; workspaceRoot?: string;
}
interface Admission extends ServerAdmissionContext {
  toolName: string; fingerprint: string; allowSavedSearchKey: boolean;
}
const admissions = new WeakMap<object, Admission>();

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function invocationArgs(args: Record<string, unknown>, allowSavedSearchKey: boolean): Record<string, unknown> {
  if (!allowSavedSearchKey) return args;
  // executeTool enriches only web_search, adding the locally saved Brave key.
  // All original arguments, including an explicitly supplied key, stay bound.
  const { api_key: _savedKey, ...original } = args;
  return original;
}
export function createServerToolAdmission(input: Required<ServerAdmissionContext> & {
  toolName: string; args: Record<string, unknown>;
}): ServerToolAdmission {
  const allowSavedSearchKey = input.toolName === 'web_search' && !Object.hasOwn(input.args, 'api_key');
  const token = Object.freeze({}) as ServerToolAdmission;
  admissions.set(token, { chatId: input.chatId, executionId: input.executionId, toolCallId: input.toolCallId,
    modeId: input.modeId, workspaceRoot: input.workspaceRoot, toolName: input.toolName, allowSavedSearchKey,
    fingerprint: stable(invocationArgs(input.args, allowSavedSearchKey)) });
  return token;
}

/** Consume only after the current permission Off check has passed. */
export function consumeServerToolAdmission(token: unknown, toolName: string, args: Record<string, unknown>, context: ServerAdmissionContext): boolean {
  if (!token || typeof token !== 'object') return false;
  const admission = admissions.get(token);
  if (!admission || admission.toolName !== toolName || admission.chatId !== context.chatId ||
      admission.executionId !== context.executionId || admission.toolCallId !== context.toolCallId ||
      admission.modeId !== context.modeId || admission.workspaceRoot !== context.workspaceRoot ||
      admission.fingerprint !== stable(invocationArgs(args, admission.allowSavedSearchKey))) return false;
  admissions.delete(token);
  return true;
}
