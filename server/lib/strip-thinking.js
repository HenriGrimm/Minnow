// Shared server helper.
/** @typedef {'think' | 'thinking' | 'thought'} ThinkTagName */

const THINK_TAG_NAME = '(?:think(?:ing)?|thought)';

const THINK_CLOSED_RE = new RegExp(
  `<${THINK_TAG_NAME}(?:\\s+[^>]*)?>[\\s\\S]*?</${THINK_TAG_NAME}>\\s*`,
  'gi',
);
const THINK_TAG_RE = new RegExp(`</?${THINK_TAG_NAME}[^>]*>\\s*`, 'gi');
const THINK_OPEN_RE = new RegExp(`<${THINK_TAG_NAME}(?:\\s+[^>]*)?>[\\s\\S]*$`, 'i');
const THINK_ATTR_RE = new RegExp(`<${THINK_TAG_NAME}\\s+[^>]*>`, 'gi');
const THINK_ATTR_CLOSE_RE = new RegExp(`</${THINK_TAG_NAME}\\s+[^>]*>`, 'gi');
const GEMMA_THOUGHT_OPEN_RE = /<\|channel>thought\s*\n?[\s\S]*$/i;
const GEMMA_RESPONSE_CHANNEL_RE = /<\|channel>response\s*\n?([\s\S]*?)<channel\|>/gi;
const GEMMA_RESPONSE_OPEN_RE = /<\|channel>response\s*\n?/gi;
const GEMMA_CHANNEL_CLOSE_RE = /<channel\|>/gi;
const THOUGHT_TAG_OPEN_RE = /<thought(\s+[^>]*)?>/gi;
const THOUGHT_TAG_CLOSE_RE = /<\/thought>/gi;
const GEMMA_THOUGHT_CHANNEL_CAPTURE_RE =
  /<\|channel>thought\s*\n?([\s\S]*?)<channel\|>\s*/gi;
const REPLY_BODY_START =
  '(?:#|\\*\\*|Dear |Hi[,! ]|Hello |Thanks|Thank you |Best[, ]|Regards|Sincerely|I hope|Looking forward|Sounds good)';
const QWEN_THINKING_RE = new RegExp(
  `^Thinking(?:\\s+Process)?:.*?(?=\\n\\n${REPLY_BODY_START}|\\Z)`,
  'is',
);
const PROMPT_ECHO_RES = [
  /^The user asks:.*?(?=\n\n#|\n\n\*\*[A-Z]|\Z)/s,
  /^We need to.*?(?=\n\n#|\n\n\*\*[A-Z]|\Z)/s,
];

/**
 * @type {readonly string[]}
 */
export const LOW_QUALITY_MARKERS = Object.freeze([
  'insufficient to',
  'content is insufficient',
  'no substantive data',
  'does not contain',
  'not relevant to',
  'no relevant information',
  'unable to extract',
  'completely unrelated',
  'boilerplate',
  'footer text',
  'cookie consent',
  'cookie banner',
  'cookie notice',
  'copyright notice',
  'copyright footer',
  'all rights reserved',
]);

/**
 * @param {string} text
 * @returns {string}
 */
export function normalizeThinkingMarkup(text) {
  if (!text) {
    return text;
  }
  let out = text.replace(THOUGHT_TAG_OPEN_RE, (_match, attrs) => `<think${attrs || ''}>`);
  out = out.replace(THOUGHT_TAG_CLOSE_RE, '</think>');

  out = out.replace(GEMMA_THOUGHT_CHANNEL_CAPTURE_RE, (_match, thought) => {
    const trimmed = String(thought).trim();
    return trimmed ? `<think>${trimmed}</think>\n` : '';
  });
  out = out.replace(GEMMA_RESPONSE_CHANNEL_RE, (_match, response) => response);
  out = out.replace(GEMMA_RESPONSE_OPEN_RE, '');
  out = out.replace(GEMMA_CHANNEL_CLOSE_RE, '');
  return out;
}

/**
 * @param {string} text
 * @param {{ prose?: boolean, promptEcho?: boolean }} [options]
 * @returns {string}
 */
export function stripThink(text, options = {}) {
  const { prose = false, promptEcho = true } = options;
  if (!text) {
    return '';
  }

  let out = normalizeThinkingMarkup(text);
  out = out.replace(GEMMA_THOUGHT_OPEN_RE, '');
  out = out.replace(THINK_ATTR_RE, '<think>');
  out = out.replace(THINK_ATTR_CLOSE_RE, '</think>');

  let prev = null;
  while (prev !== out) {
    prev = out;
    out = out.replace(THINK_CLOSED_RE, '');
  }
  out = out.replace(THINK_OPEN_RE, '');
  out = out.replace(THINK_TAG_RE, '');

  if (promptEcho) {
    out = out.replace(QWEN_THINKING_RE, '');
    for (const re of PROMPT_ECHO_RES) {
      out = out.replace(re, '');
    }
  }

  if (prose) {
    out = stripReasoningProse(out);
  }

  return out.trim();
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripReasoningProse(text) {
  if (!text || !text.trim()) {
    return text;
  }
  const paragraphs = text.trim().split(/\n\s*\n/);
  if (paragraphs.length <= 1) {
    return text;
  }

  const REASONING_PREFIX_RE =
    /^\s*(?:thinking(?:\s+process)?\s*:|the user (?:wants|is|asks|needs|wrote|said|told|messaged|requested)|i (?:need|should|have|'ll|will|am going)(?: to)? (?:write|draft|reply|respond|read|check|look|review|consider|think|provide|generate|produce|craft|compose|acknowledge|summarize|answer|give|keep|aim|make|address|focus|use|just|simply|analyze|format|create|build|note|decide)|let me (?:think|look|see|check|read|review|consider|draft|write|analyze|format|summarize|create|produce|craft|note|extract|identify|figure)|looking at (?:the|this|that)|(?:okay|alright|hmm|right|so|well|first|next|now)[,.]?\s+(?:the|i|let|so|now|this|here)|based on (?:the|this|what|context)|to (?:draft|write|reply|respond|summarize|answer))\b/i;

  let firstKeep = 0;
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (REASONING_PREFIX_RE.test(paragraphs[i])) {
      firstKeep = i + 1;
    } else {
      break;
    }
  }
  if (firstKeep === 0) {
    return text;
  }
  const keep = paragraphs.slice(firstKeep);
  return keep.length ? keep.join('\n\n').trim() : text;
}

/**
 * @param {string | null | undefined} text
 * @returns {string | null | undefined}
 */
export function stripThinking(text) {
  if (text == null) {
    return text;
  }
  return stripThink(text, { prose: false, promptEcho: true });
}

/**
 * @param {string | null | undefined} text
 * @returns {string | null | undefined}
 */
export function stripDraftOutput(text) {
  if (text == null) {
    return text;
  }
  return stripThink(text, { prose: true, promptEcho: true });
}

/**
 * @param {unknown} summary
 * @returns {boolean}
 */
export function isLowQuality(summary) {
  try {
    if (typeof summary !== 'string' || !summary) {
      return true;
    }
    const low = summary.toLowerCase();
    return LOW_QUALITY_MARKERS.some((marker) => low.includes(marker));
  } catch {
    return false;
  }
}

const STOP_ANSWER_PREFIX_RE = /^[\s*_`"'#>-]+/;

/**
 * @param {string | null | undefined} response
 * @returns {boolean}
 */
export function parseStopDecision(response) {
  try {
    const cleaned = stripThinking(response);
    if (cleaned == null || !String(cleaned).trim()) {
      return false;
    }
    const answer = String(cleaned).trim().replace(STOP_ANSWER_PREFIX_RE, '').toUpperCase();
    return answer.startsWith('YES');
  } catch {
    return false;
  }
}
