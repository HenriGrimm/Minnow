/** Advisory nudges about how an attempt spends its model rounds; never deny a call. */

/** Single-call rounds in a row before the first batching nudge. */
export const BATCH_STREAK = 4;
/** Further single-call rounds before the nudge repeats. */
export const BATCH_REPEAT = 10;

// An edit is the natural end of a lookup chain; a lone edit round is not a
// missed batch.
const EDIT_TOOLS = new Set([
  'apply_patch',
  'save_file',
  'replace_text_in_file',
  'append_file',
  'insert_at_line',
  'make_directory',
  'move_file',
  'copy_file',
  'delete_path',
]);

/**
 * @param {{ batching?: boolean, verdictRounds?: number | null }} [options]
 *   `batching` nudges a model that spends one full round per lookup.
 *   `verdictRounds` asks a verifier for its verdict once that many rounds have run.
 */
export function createRoundShapeGuard(options = {}) {
  const batching = options.batching === true;
  const verdict =
    Number.isFinite(options.verdictRounds) && Number(options.verdictRounds) > 0
      ? Math.floor(Number(options.verdictRounds))
      : null;
  let streak = 0;
  return {
    /**
     * @param {string[]} names tool names the model called this round
     * @param {number} round 1-based model round that produced them
     * @returns {string | null}
     */
    note(names, round) {
      /** @type {string[]} */
      const notes = [];
      if (batching) {
        if (names.length === 1 && !EDIT_TOOLS.has(names[0])) streak++;
        else streak = 0;
        if (streak === BATCH_STREAK || (streak > BATCH_STREAK && (streak - BATCH_STREAK) % BATCH_REPEAT === 0)) {
          notes.push(`[Minnow batching checkpoint: your last ${streak} rounds each made a single call, and every round costs a full model pass. When calls do not depend on each other, send them together in one message — several read_file/grep calls, or several execute_command calls (they run in order). Wait for a result only when the next call needs it.]`);
        }
      }
      if (verdict != null) {
        const firm = verdict + Math.ceil(verdict / 2);
        if (round === verdict) {
          notes.push(`[Minnow verdict checkpoint: ${round} rounds in. List which Test/Accept criteria are verified and which remain. Run only the remaining checks, then call report_outcome.]`);
        } else if (round >= firm && (round - firm) % 10 === 0) {
          notes.push(`[Minnow verdict checkpoint: ${round} rounds. Call report_outcome now — pass if every criterion is verified; otherwise fail and put what is unverified, and why, in testOutput.]`);
        }
      }
      return notes.length ? notes.join('\n\n') : null;
    },
  };
}
