/**
 * Client half of the board boot resume gate (server side:
 * `server/orchestrator/resume-gate.js`).
 *
 * V2 boards live on the server, so the renderer cannot decide whether one
 * resumes — it can only ask which boards the engine is holding and relay the
 * user's answer. The hold itself is server-side because a bare GET is enough to
 * build an engine and restart its agents.
 */

/** A board the server is holding until the user answers. */
export interface PendingBoardResume {
  boardId: string;
  name: string;
  /** Tasks on the board, matching what `GET /api/boards` reports. */
  taskCount: number;
}

/**
 * Boards awaiting an answer.
 *
 * Never throws: the gate must not block boot because the local server is down —
 * with no server there is also nothing running to prompt about.
 */
export async function fetchPendingBoardResumes(): Promise<PendingBoardResume[]> {
  try {
    const res = await fetch('/api/boards/resume/pending');
    if (!res.ok) return [];
    const body = (await res.json()) as { ok?: boolean; boards?: PendingBoardResume[] };
    if (!body?.ok || !Array.isArray(body.boards)) return [];
    return body.boards;
  } catch {
    return [];
  }
}

/**
 * Relay the user's answer for the boards shown in the prompt.
 *
 * `decline` makes the server persist a user stop, so the board reads as Stopped,
 * Start re-arms it, and the next boot does not ask about it again.
 *
 * @returns true when the server accepted the decision
 */
export async function resolveBoardResumes(
  decision: 'resume' | 'decline',
  boards: readonly PendingBoardResume[],
): Promise<boolean> {
  try {
    const res = await fetch('/api/boards/resume/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, boardIds: boards.map((board) => board.boardId) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
