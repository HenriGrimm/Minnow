/** Share of the context window one read may fill. */
export declare const READ_CONTEXT_SHARE: number;
/** Floor so a tiny window still gets a usable window of lines. */
export declare const MIN_READ_BUDGET_CHARS: number;
export declare const UNCHANGED_READ_PREFIX: string;
/** Read character budget for a context window; null when the window is unknown. */
export declare function readBudgetCharsForContext(contextLimitTokens: number | null | undefined): number | null;
/** Args with max_output_chars lowered to the context budget (read tools only). */
export declare function withReadBudget(
  name: string,
  args: Record<string, unknown>,
  budgetChars: number | null,
): Record<string, unknown>;
export declare function isUnchangedReadStub(content: unknown): boolean;
/** Stub for a read whose identical output is still verbatim in context, else null. */
export declare function unchangedReadStub(
  messages: ReadonlyArray<unknown>,
  toolName: string,
  args: Record<string, unknown>,
  content: unknown,
): string | null;
