let toolConfigEpoch = 0;
let promptConfigEpoch = 0;

export function getToolConfigEpoch(): number {
  return toolConfigEpoch;
}

export function getPromptConfigEpoch(): number {
  return promptConfigEpoch;
}

/** Call after tool enablement, MCP, or related settings are persisted. */
export function bumpToolConfigEpoch(): void {
  toolConfigEpoch += 1;
}

/** Call after system prompt overrides or user rules are persisted. */
export function bumpPromptConfigEpoch(): void {
  promptConfigEpoch += 1;
}

/** Reset epochs between unit tests. */
export function resetOutboundEstimateEpochsForTests(): void {
  toolConfigEpoch = 0;
  promptConfigEpoch = 0;
}
