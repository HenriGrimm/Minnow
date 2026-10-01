/** Fixed host RAM budgets; overflow fails explicitly rather than truncating replay. */
export const GENERATION_REPLAY_BYTES = 32 * 1024 * 1024;
export const GENERATION_REQUEST_BYTES = 32 * 1024 * 1024;
export const GENERATIONS_TOTAL_BYTES = 128 * 1024 * 1024;
export const GENERATIONS_MAX_COUNT = 1024;
export const SUBSCRIBER_BACKLOG_BYTES = 4 * 1024 * 1024;
export const SUBSCRIBER_STALL_MS = 30_000;
export const SUBSCRIBERS_MAX_COUNT = 128;
export const CHUNK_OVERHEAD_BYTES = 256;
export const GENERATION_OVERHEAD_BYTES = 512;
export const REPLAY_LIMIT_MESSAGE = 'Reply stopped because the generation replay memory limit was reached. Start a new turn with a smaller output budget.';
export const CHECKPOINT_LIMIT_MESSAGE = 'Saved reply exceeds the available replay memory budget; its content was not loaded.';
