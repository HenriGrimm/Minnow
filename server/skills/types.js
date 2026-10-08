/**
 * @typedef {'builtin' | 'user'} SkillSource
 */

/**
 * @typedef {Object} SkillListItem
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {SkillSource} source
 * @property {string} path
 * @property {string} [version]
 * @property {boolean} [disableModelInvocation]
 */

/**
 * @typedef {SkillListItem & { body: string, disableModelInvocation?: boolean }} SkillDetail
 */

export {};
