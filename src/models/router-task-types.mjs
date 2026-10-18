/** Task specialties for Auto pools, independent of capability tier and reasoning. */
export const ROUTER_TASK_TYPES = /** @type {const} */ ([
  'general', 'coding', 'ux-design', 'debugging', 'code-review', 'planning', 'research', 'writing',
]);

export const ROUTER_TASK_CRITERIA = {
  general: 'Conversation, everyday questions, quick help, or requests with no clear specialty.',
  coding: 'Implement, change, refactor, or test code. Choose this when implementation is the main deliverable.',
  'ux-design': 'Design or critique interfaces, layouts, visual styling, user flows, usability, or accessibility. Includes frontend implementation driven primarily by design.',
  debugging: 'Investigate failures, diagnose errors, reproduce bugs, or find and fix an unclear root cause.',
  'code-review': 'Review existing code or diffs for correctness, security, regressions, and maintainability.',
  planning: 'Plan work, break down tasks, or make architecture and technical design decisions before implementation.',
  research: 'Find, verify, compare, and synthesize information or investigate an unfamiliar topic.',
  writing: 'Draft, edit, summarize, or translate prose, documentation, and other written content.',
};

/** @param {unknown} value */
export function isRouterTaskType(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (ROUTER_TASK_TYPES).includes(value);
}

/** @param {string} value */
export function formatRouterTaskTypeLabel(value) {
  const labels = {
    general: 'General', coding: 'Coder', 'ux-design': 'UX Design', debugging: 'Debugging',
    'code-review': 'Code Review', planning: 'Planning', research: 'Research', writing: 'Writing',
  };
  return labels[value] || value;
}
