import { isOpenCodeGoBaseUrl } from '../../src/lib/openai-responses-route.mjs';

/**
 * Go models can spend the entire short utility cap on mandatory reasoning.
 * GLM-5.3-Flash also rejects caps <=1024 outright. Keep room for the answer;
 * this is a total reasoning + output allowance, not a requested answer length.
 * @param {Record<string, unknown>} body
 * @param {string | undefined} baseUrl
 * @param {string | null | undefined} fallbackRole
 * @returns {Record<string, unknown>}
 */
export function withUtilityOutputBudget(body, baseUrl, fallbackRole) {
  if (!isOpenCodeGoBaseUrl(baseUrl)) return body;
  const thinkingOff = body.thinking?.type === 'disabled' || body.enable_thinking === false;
  const utilityRole = ['utility', 'chat-titles', 'editor-completion'].includes(fallbackRole);
  if (!utilityRole && !(!fallbackRole && thinkingOff)) return body;
  const key = typeof body.max_output_tokens === 'number' ? 'max_output_tokens'
    : typeof body.max_completion_tokens === 'number' ? 'max_completion_tokens' : 'max_tokens';
  const cap = body[key];
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0 || cap >= 2048) return body;
  return { ...body, [key]: 2048 };
}
