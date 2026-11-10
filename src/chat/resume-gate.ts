export type ResumeGateState = 'idle' | 'pending' | 'resumed' | 'declined';

let gateState: ResumeGateState = 'idle';
const declinedChats = new Set<string>();

/** Whether auto-resume paths must stand down (prompt unanswered or declined). */
export function isResumeGateHeld(chatId?: string): boolean {
  return gateState === 'pending' || gateState === 'declined' || Boolean(chatId && declinedChats.has(chatId));
}

export function declineChatAutoResume(chatId: string): void {
  declinedChats.add(chatId);
}

/** Current gate state (diagnostics and tests). */
export function getResumeGateState(): ResumeGateState {
  return gateState;
}

/** Set the gate state (boot gate and tests). */
export function setResumeGateState(state: ResumeGateState): void {
  if (state === 'idle') declinedChats.clear();
  gateState = state;
}
