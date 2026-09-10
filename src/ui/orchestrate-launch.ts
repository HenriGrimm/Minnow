import { normalizeOrchestratePlanPath } from '../chat/plans/plan-path';

/** What a plan launch resolved to. No chat row — V2 boards are journals. */
export interface BoardLaunchResult {
  boardId: string;
}

/** Create a V2 board from a plan file and open the Boards surface on it. */
export async function launchBoardFromPlan(
  planPath: string,
): Promise<BoardLaunchResult | null> {
  const norm = normalizeOrchestratePlanPath(planPath);
  if (!norm) return null;

  const { createAndShowBoardFromPlan } = await import('../orchestrator/boards-view');
  const creation = createAndShowBoardFromPlan(norm);
  const { navigateToCodeBoards } = await import('../os/router');
  navigateToCodeBoards();

  try {
    return await creation;
  } catch (err) {
    console.error('[orchestrate] create board from plan failed', err);
    return null;
  }
}
