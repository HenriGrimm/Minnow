// Shared server helper.
/**
 * JSON repair helpers for Deep Research LLM output.
 * JSON parsing helpers for fenced code blocks and LLM output arrays/objects.
 */

/**
 * Strip markdown code-block fences (```json ... ```) if present.
 * @param {string} text
 * @returns {string}
 */
export function stripCodeBlock(text) {
  let out = String(text ?? '').trim();
  if (out.startsWith('```')) {
    out = out.replace(/^```(?:json)?\s*/i, '');
    out = out.replace(/\s*```$/, '');
  }
  return out.trim();
}

/**
 * Extract a JSON array of strings from LLM output.
 * @param {string} text
 * @returns {string[]}
 */
export function parseJsonArray(text) {
  let body = stripCodeBlock(text);
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }
  } catch {
    /* fall through */
  }

  const lastStart = body.lastIndexOf('[');
  const truncated = lastStart !== -1 && !body.slice(lastStart).includes(']');
  if (truncated) {
    const completeItems = [...body.slice(lastStart).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (completeItems.length) {
      return completeItems;
    }
  }

  const greedy = body.match(/\[[\s\S]*\]/);
  if (greedy) {
    try {
      const parsed = JSON.parse(greedy[0]);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item));
      }
    } catch {
      /* fall through */
    }
  }

  let lastParsed = null;
  for (const match of body.matchAll(/\[[\s\S]*?\]/g)) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        lastParsed = parsed;
      }
    } catch {
      /* continue */
    }
  }
  if (lastParsed !== null) {
    return lastParsed.map((item) => String(item));
  }

  const arrStart = body.indexOf('[');
  if (arrStart !== -1) {
    const fragment = body.slice(arrStart);
    const completeItems = [...fragment.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (completeItems.length) {
      return completeItems;
    }
  }

  return [];
}

/**
 * Extract a JSON object from LLM output.
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
export function parseJsonObject(text) {
  const body = stripCodeBlock(text);
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return /** @type {Record<string, unknown>} */ (parsed);
    }
  } catch {
    /* fall through */
  }

  const greedy = body.match(/\{[\s\S]*\}/);
  if (greedy) {
    try {
      const parsed = JSON.parse(greedy[0]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return /** @type {Record<string, unknown>} */ (parsed);
      }
    } catch {
      /* fall through */
    }
  }

  return null;
}
