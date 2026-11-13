/**
 * JSDoc types for agent pack scan results.
 */

/**
 * @typedef {object} ScannedAgentPack
 * @property {string} id
 * @property {string} label
 * @property {string} version
 * @property {string} [description]
 * @property {boolean} enabled
 * @property {boolean} valid
 * @property {string[]} errors
 * @property {Array<{ id: string, key: string, label: string, description?: string }>} agents
 * @property {string} packRoot
 * @property {object | null} manifest — validated manifest when valid
 */

/**
 * @typedef {object} PackAgentRuntime
 * @property {string} packId
 * @property {string} agentKey
 * @property {string} packRoot
 * @property {{ full: string }} promptPaths
 */

export {};
