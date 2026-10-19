import { normalizeHarmonyToolName } from "./harmony-tool-calls.js";

const THINK_TAG = "(?:(?:redacted_)?think(?:ing)?|thought)";
const REDACTED_THINKING_OPEN = "<redacted_thinking>";
const REDACTED_THINKING_CLOSE = "</redacted_thinking>";
function redactedThinkingBlock(inner, suffix = "") {
  return `${REDACTED_THINKING_OPEN}${inner}${REDACTED_THINKING_CLOSE}${suffix}`;
}
const THINK_OPEN_RE = new RegExp(`^<${THINK_TAG}(?:\\s+[^>]*)?>`, "i");
const THINK_CLOSE_RE = new RegExp(`</${THINK_TAG}>`, "i");
const THINK_TAG_ATTR_OPEN_RE = new RegExp(`<${THINK_TAG}\\s+[^>]*>`, "gi");
const THINK_TAG_ATTR_CLOSE_RE = new RegExp(`</${THINK_TAG}\\s+[^>]*>`, "gi");
const THOUGHT_TAG_OPEN_RE = /<thought(\s+[^>]*)?>/gi;
const THOUGHT_TAG_CLOSE_RE = /<\/thought>/gi;
const GEMMA_THOUGHT_CHANNEL_CAPTURE_RE = /<\|channel>thought\s*\n?([\s\S]*?)<channel\|>\s*/gi;
const GEMMA_RESPONSE_CHANNEL_RE = /<\|channel>response\s*\n?([\s\S]*?)<channel\|>/gi;
const GEMMA_RESPONSE_OPEN_RE = /<\|channel>response\s*\n?/gi;
const GEMMA_CHANNEL_CLOSE_RE = /<channel\|>/gi;
const THINKING_PREFIX_RE = /^thinking(?:\s+process)?\s*:\s*/i;
const REASONING_PREFIX_RE = /^\s*(?:thinking(?:\s+process)?\s*:|the user |i need |i should |i will |they are |the question |i can )/i;
const REASONING_PROSE_PREFIX_RE = /^\s*(?:the user (?:wants|is|asks|needs|wrote|said|told|messaged|requested)|i (?:need|should|have|'ll|will|am going)(?: to)? (?:write|draft|reply|respond|read|check|look|review|consider|think|provide|generate|produce|craft|compose|acknowledge|summarize|answer|give|keep|aim|make|address|focus|use|just|simply|analyze|format|create|build|note|decide)|let me (?:think|look|see|check|read|review|consider|draft|write|analyze|format|summarize|create|produce|craft|note|extract|identify|figure)|looking at (?:the|this|that)|(?:okay|alright|hmm|right|so|well|first|next|now)[,.]?\s+(?:the|i|let|so|now|this|here)|based on (?:the|this|what|context)|to (?:draft|write|reply|respond|summarize|answer))\b/i;
const GARBLED_THINK_RE = new RegExp(
  `^([\\s\\S]+?)\\n*<${THINK_TAG}\\s*>\\s*([\\s\\S]*?)(?:</${THINK_TAG}>)?\\s*$`,
  "i"
);
const THINK_BLOCK_RE = new RegExp(
  `^[\\s]*<${THINK_TAG}(?:\\s+[^>]*)?>([\\s\\S]*?)</${THINK_TAG}>\\s*([\\s\\S]*)`,
  "i"
);
const THINKING_MODEL_PATTERNS = [
  "qwen3",
  "qwq",
  "deepseek-r1",
  "deepseek-reasoner",
  "minimax",
  "m2-reap",
  "gemma"
];
const REASONING_STARTS = [
  "The user ",
  "I need ",
  "I should ",
  "I will ",
  "They are ",
  "The question ",
  "I can ",
  "Thinking Process",
  "Thinking:"
];
const REPLY_STARTS = [
  "Hey",
  "Hi ",
  "Hi!",
  "Hello",
  "Sure",
  "Yes",
  "No ",
  "No,",
  "Yo",
  "OK",
  "Here",
  "Absolutely",
  "Of course",
  "Great",
  "Alright",
  "Thanks",
  "Welcome",
  "Good ",
  "I'm happy",
  "I'd be"
];
const HARMONY_MARKER_RE = new RegExp(
  "<\\|channel\\|>(analysis|commentary|final)|<\\|start\\|>(?:assistant|system|user|tool)?|<\\|constrain\\|>\\s*\\w*|<\\|message\\|>|<\\|end\\|>|<\\|return\\|>|<\\|call\\|>"
);
const HARMONY_MARKERS = [
  "<|channel|>analysis",
  "<|channel|>commentary",
  "<|channel|>final",
  "<|start|>assistant",
  "<|start|>system",
  "<|start|>user",
  "<|start|>tool",
  "<|start|>",
  "<|constrain|>json",
  "<|constrain|>",
  "<|message|>",
  "<|end|>",
  "<|return|>",
  "<|call|>"
];
const HARMONY_MAX_MARKER_LEN = Math.max(...HARMONY_MARKERS.map((marker) => marker.length));
function normalizeThinkingMarkup(text) {
  if (!text) {
    return text;
  }
  let out = text.replace(THOUGHT_TAG_OPEN_RE, (_match, attrs) => `<think${attrs || ""}>`);
  out = out.replace(THOUGHT_TAG_CLOSE_RE, REDACTED_THINKING_CLOSE);
  out = out.replace(GEMMA_THOUGHT_CHANNEL_CAPTURE_RE, (_match, thought) => {
    const trimmed = String(thought).trim();
    return trimmed ? redactedThinkingBlock(trimmed, "\n") : "";
  });
  out = out.replace(GEMMA_RESPONSE_CHANNEL_RE, (_match, response) => response);
  out = out.replace(GEMMA_RESPONSE_OPEN_RE, "");
  out = out.replace(GEMMA_CHANNEL_CLOSE_RE, "");
  return out;
}
function startsWithReasoningPrefix(text) {
  return REASONING_PREFIX_RE.test(text || "");
}
function stripThinkingPrefix(text) {
  return text.replace(THINKING_PREFIX_RE, "");
}
function reasoningStartsWith(text) {
  const stripped = text.trimStart();
  return REASONING_STARTS.some((prefix) => stripped.startsWith(prefix)) || REASONING_PREFIX_RE.test(stripped);
}
function normalizePlainThinking(text) {
  if (!text) {
    return text;
  }
  let out = normalizeThinkingMarkup(text);
  const garbled = GARBLED_THINK_RE.exec(out);
  if (garbled) {
    const before = garbled[1].trim();
    const after = garbled[2].trim();
    const strippedBefore = before.trimStart();
    if (reasoningStartsWith(strippedBefore)) {
      const think = stripThinkingPrefix(strippedBefore);
      return redactedThinkingBlock(think, `
${after}`);
    }
  }
  if (/<think/i.test(out)) {
    return out;
  }
  if (THINKING_PREFIX_RE.test(out.trimStart())) {
    const boundary = new RegExp(
      "^(Thinking(?:\\s+Process)?:[\\s\\S]*?)(\\n\\n(?=[A-Z]|Hey|Yo|Hi|Sure|I |What|Here|Let|The |This |OK|Ok|Yes|No |So |Well |Thank|Alright|Of course|Absolutely|Great|Hello|As ))",
      "i"
    );
    const match = boundary.exec(out);
    if (match) {
      const think2 = stripThinkingPrefix(match[1]).trim();
      return redactedThinkingBlock(think2, out.slice(match.index + match[1].length));
    }
    const parts = out.split("\n\n");
    for (let i = parts.length - 1; i > 0; i -= 1) {
      const line = parts[i].trim();
      if (line && !/^[\d*\-\s(]/.test(line) && line.length > 5) {
        const think2 = stripThinkingPrefix(parts.slice(0, i).join("\n\n")).trim();
        const reply = parts.slice(i).join("\n\n");
        return redactedThinkingBlock(think2, `

${reply}`);
      }
    }
    const quotes = [...out.matchAll(/["\u201c]([^"\u201d]{10,})["\u201d]/g)];
    if (quotes.length > 0) {
      const reply = quotes[quotes.length - 1][1].trim();
      const think2 = stripThinkingPrefix(out).trim();
      return redactedThinkingBlock(think2, `

${reply}`);
    }
    const think = stripThinkingPrefix(out).trim();
    return redactedThinkingBlock(think);
  }
  const strippedText = out.trimStart();
  const firstLine = strippedText.split("\n")[0].trim();
  if (REASONING_STARTS.some((prefix) => firstLine.startsWith(prefix))) {
    const lines = strippedText.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const stripped = lines[i].trim();
      if (!stripped) {
        continue;
      }
      if (i > 0 && REPLY_STARTS.some((prefix) => stripped.startsWith(prefix))) {
        return redactedThinkingBlock(lines.slice(0, i).join("\n"), `
${lines.slice(i).join("\n")}`);
      }
    }
    for (const prefix of REPLY_STARTS) {
      const pattern = new RegExp(`([.!?])\\s*(${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`);
      const match = pattern.exec(strippedText);
      if (match && match.index > 20) {
        const think = strippedText.slice(0, match.index + 1);
        const reply = strippedText.slice(match.index + 1).trimStart();
        return redactedThinkingBlock(think, `
${reply}`);
      }
    }
    for (let i = lines.length - 1; i > 0; i -= 1) {
      const stripped = lines[i].trim();
      if (stripped && !REASONING_STARTS.some((prefix) => stripped.startsWith(prefix)) && !stripped.startsWith("*") && stripped.length > 3) {
        return redactedThinkingBlock(lines.slice(0, i).join("\n"), `
${lines.slice(i).join("\n")}`);
      }
    }
  }
  return out;
}
function parseThinkBlock(text) {
  const clean = text.replace(THINK_TAG_ATTR_OPEN_RE, "<think").replace(THINK_TAG_ATTR_CLOSE_RE, REDACTED_THINKING_CLOSE);
  const match = THINK_BLOCK_RE.exec(clean);
  if (!match) {
    return null;
  }
  return {
    thinking: match[1].trim(),
    reply: match[2].trim()
  };
}
function extractInlineThinkingFromContent(text) {
  if (!text) {
    return { thinking: [], reply: "" };
  }
  const originalText = text;
  const normalized = normalizeThinkingMarkup(text);
  const normalizedChanged = normalized !== originalText;
  const parsed = parseThinkBlock(normalized);
  if (parsed?.thinking && parsed.reply) {
    return { thinking: [parsed.thinking], reply: parsed.reply };
  }
  const wrapped = normalizePlainThinking(normalized);
  const wrappedParsed = parseThinkBlock(wrapped);
  if (wrappedParsed?.thinking && wrappedParsed.reply) {
    return { thinking: [wrappedParsed.thinking], reply: wrappedParsed.reply };
  }
  if (normalizedChanged && text.trim()) {
    return { thinking: [], reply: text.trim() };
  }
  return { thinking: [], reply: text };
}
function findThinkClose(content) {
  const match = THINK_CLOSE_RE.exec(content);
  if (!match || match.index === void 0) {
    return null;
  }
  return { index: match.index, length: match[0].length };
}
function stripThinkOpenTag(content) {
  const match = THINK_OPEN_RE.exec(content.trimStart());
  if (!match) {
    return content;
  }
  return content.trimStart().slice(match[0].length);
}
function stripTrailingThinkClose(text) {
  return text.replace(new RegExp(`</${THINK_TAG}>\\s*$`, "i"), "").trimEnd();
}
const THINK_OPEN_MARKERS = [
  REDACTED_THINKING_OPEN,
  "<thinking>",
  "<thought>",
  "<think>"
];
const MAX_THINK_OPEN_LEN = Math.max(...THINK_OPEN_MARKERS.map((marker) => marker.length));
const MAX_THINK_OPEN_ATTR_LEN = 256;
const THINK_OPEN_ATTR_PARTIAL_RE = new RegExp(`^<${THINK_TAG}\\s[^>]*$`, "i");
const THINK_TAG_NAMES = ["think", "thinking", "thought", "redacted_think", "redacted_thinking"];
const THINK_BOUNDARY_TAGS = THINK_TAG_NAMES.flatMap((name) => [
  `<${name}>`,
  `<${name} `,
  `</${name}>`
]);
const MAX_THINK_BOUNDARY_LEN = Math.max(...THINK_BOUNDARY_TAGS.map((tag) => tag.length));
function thinkTagSuffixHoldLen(text) {
  const limit = Math.min(text.length, MAX_THINK_BOUNDARY_LEN - 1);
  for (let n = limit; n > 0; n -= 1) {
    const suffix = text.slice(-n).toLowerCase();
    if (!suffix.startsWith("<")) {
      continue;
    }
    if (THINK_BOUNDARY_TAGS.some((tag) => tag.startsWith(suffix))) {
      return n;
    }
  }
  return 0;
}
function isThinkOpenPrefix(text) {
  const lower = text.trimStart().toLowerCase();
  if (!lower.startsWith("<")) {
    return false;
  }
  if (THINK_OPEN_ATTR_PARTIAL_RE.test(lower)) {
    return true;
  }
  return THINK_OPEN_MARKERS.some((marker) => marker.startsWith(lower) || lower.startsWith(marker));
}
function completeThinkOpenAtStart(text) {
  const trimmed = text.trimStart();
  const lead = text.length - trimmed.length;
  const tagMatch = THINK_OPEN_RE.exec(trimmed);
  if (tagMatch) {
    return lead + tagMatch[0].length;
  }
  const lower = trimmed.toLowerCase();
  for (const marker of THINK_OPEN_MARKERS) {
    if (lower.startsWith(marker)) {
      return lead + marker.length;
    }
  }
  return null;
}
const STANDALONE_THINK_OPEN_RE = new RegExp(
  `(^|[\r\n])[ \t]*(<${THINK_TAG}(?:\s+[^>]*)?>)`,
  "i"
);
function findStandaloneThinkOpen(text) {
  const match = STANDALONE_THINK_OPEN_RE.exec(text);
  if (!match || match.index === void 0) {
    return null;
  }
  const tag = match[2];
  return { index: match.index + match[0].length - tag.length, length: tag.length };
}
function startsWithStandaloneThinkOpen(text) {
  const open = findStandaloneThinkOpen(text);
  return Boolean(open && text.slice(0, open.index).trim() === "");
}
function findReasoningProseSplit(text) {
  const trimmed = text.trimStart();
  if (!startsWithReasoningPrefix(trimmed) && !THINKING_PREFIX_RE.test(trimmed)) {
    return null;
  }
  const prefixRegex = THINKING_PREFIX_RE;
  const strayClose = findThinkClose(trimmed);
  if (strayClose && strayClose.index > 0 && !THINK_OPEN_RE.test(trimmed)) {
    const thinking = stripTrailingThinkClose(trimmed.slice(0, strayClose.index).replace(prefixRegex, "").trim());
    const reply = trimmed.slice(strayClose.index + strayClose.length).trimStart();
    if (thinking && reply) {
      return { thinking, reply };
    }
  }
  const escapedReplyStarts = REPLY_STARTS.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const boundaryRegex = new RegExp(
    `^([\\s\\S]*?)(\\n\\n(?=${escapedReplyStarts.join("|")}|I |What|Let|This |As ))[\\s\\S]*$`,
    "i"
  );
  const boundaryMatch = boundaryRegex.exec(trimmed);
  if (boundaryMatch) {
    const thinkBlock = boundaryMatch[1].replace(prefixRegex, "").trim();
    const reply = trimmed.slice(boundaryMatch[1].length).trimStart();
    if (thinkBlock && reply) {
      return { thinking: thinkBlock, reply };
    }
  }
  const lines = trimmed.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    if (REPLY_STARTS.some((prefix) => line.startsWith(prefix))) {
      const thinkBlock = lines.slice(0, index).join("\n").replace(prefixRegex, "").trim();
      const reply = lines.slice(index).join("\n").trim();
      if (thinkBlock && reply) {
        return { thinking: thinkBlock, reply };
      }
    }
  }
  const withoutPrefix = trimmed.replace(prefixRegex, "");
  for (const prefix of REPLY_STARTS) {
    const rx = new RegExp(`[.!?]\\s*(${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`);
    const match = rx.exec(withoutPrefix);
    if (match && match.index > 20) {
      const thinkBlock = withoutPrefix.slice(0, match.index + 1).trim();
      const reply = withoutPrefix.slice(match.index + 1).trim();
      if (thinkBlock && reply) {
        return { thinking: thinkBlock, reply };
      }
    }
  }
  const paragraphs = trimmed.split(/\n\s*\n/);
  if (paragraphs.length > 1) {
    let firstKeep = 0;
    for (let i = 0; i < paragraphs.length; i += 1) {
      if (REASONING_PROSE_PREFIX_RE.test(paragraphs[i])) {
        firstKeep = i + 1;
      } else {
        break;
      }
    }
    if (firstKeep > 0 && firstKeep < paragraphs.length) {
      const thinkBlock = paragraphs.slice(0, firstKeep).join("\n\n").replace(prefixRegex, "").trim();
      const reply = paragraphs.slice(firstKeep).join("\n\n").trim();
      if (thinkBlock && reply) {
        return { thinking: thinkBlock, reply };
      }
    }
  }
  return null;
}
function modelLikelyUsesInlineThinking(modelId) {
  if (!modelId) {
    return false;
  }
  const lower = modelId.toLowerCase();
  return THINKING_MODEL_PATTERNS.some((pattern) => lower.includes(pattern));
}
class InlineContentThinkingRouter {
  thinkingModel;
  firstContentSent = false;
  inThinkTag = false;
  thinkOpenStripped = false;
  inReasoningProse = false;
  proseBuffer = "";
  openTagBuffer = "";
  /** Trailing bytes withheld because they may be the start of a think tag. */
  tagTail = "";
  /** Set during `flush()` so an incomplete opener is emitted instead of re-buffered. */
  finalizing = false;
  /** Latched once a buffered opener is released, so it is never re-buffered. */
  openTagAbandoned = false;
  /**
   * Candidate second (or later) think span after visible prose, including its opener.
   * Held until a matching close arrives so a code sample that merely mentions
   * `<think>` is not committed as reasoning.
   */
  midStreamThinkBuffer = "";
  constructor(options) {
    this.thinkingModel = options?.thinkingModel ?? false;
  }
  feed(text) {
    if (!text) {
      return [];
    }
    const combined = this.tagTail + text;
    const hold = thinkTagSuffixHoldLen(combined);
    this.tagTail = hold > 0 ? combined.slice(combined.length - hold) : "";
    const emit = hold > 0 ? combined.slice(0, combined.length - hold) : combined;
    if (!emit) {
      return [];
    }
    return this.routeChunk(emit);
  }
  flush() {
    const out = [];
    this.finalizing = true;
    if (this.tagTail) {
      const tail = this.tagTail;
      this.tagTail = "";
      out.push(...this.routeChunk(tail));
    }
    if (this.openTagBuffer) {
      const buffered = this.openTagBuffer;
      this.openTagBuffer = "";
      out.push(...this.routeChunk(buffered));
    }
    if (this.midStreamThinkBuffer) {
      const buffered = this.midStreamThinkBuffer;
      this.midStreamThinkBuffer = "";
      if (buffered) {
        out.push([buffered, false]);
      }
    }
    if (this.inReasoningProse && this.proseBuffer) {
      const split = findReasoningProseSplit(this.proseBuffer);
      if (split) {
        out.push([split.thinking, true], [split.reply, false]);
      } else {
        out.push([this.proseBuffer, false]);
      }
      this.proseBuffer = "";
      this.inReasoningProse = false;
      this.firstContentSent = true;
    }
    this.finalizing = false;
    return out;
  }
  drainMidStreamThink() {
    const close = findThinkClose(this.midStreamThinkBuffer);
    if (!close) {
      return [];
    }
    const openLen = completeThinkOpenAtStart(this.midStreamThinkBuffer);
    const thinkPart = this.midStreamThinkBuffer.slice(openLen ?? 0, close.index);
    const regularPart = this.midStreamThinkBuffer.slice(close.index + close.length);
    this.midStreamThinkBuffer = "";
    const out = [];
    if (thinkPart) {
      out.push([thinkPart, true]);
    }
    if (regularPart) {
      out.push(...this.routeChunk(regularPart));
    }
    return out;
  }
  routeChunk(content) {
    if (this.midStreamThinkBuffer) {
      this.midStreamThinkBuffer += content;
      return this.drainMidStreamThink();
    }
    const out = [];
    let chunk = content;
    const stripped = chunk.trimStart();
    if (!this.firstContentSent && !this.thinkingModel && !this.inThinkTag && (stripped.toLowerCase().startsWith("<think") || isThinkOpenPrefix(stripped))) {
      this.thinkingModel = true;
      this.inThinkTag = true;
    }
    if (this.thinkingModel && !this.firstContentSent && !this.inThinkTag && !this.inReasoningProse && !this.finalizing && !this.openTagAbandoned && (this.openTagBuffer || isThinkOpenPrefix(stripped))) {
      this.openTagBuffer += chunk;
      const openLen = completeThinkOpenAtStart(this.openTagBuffer);
      if (openLen != null) {
        const afterOpen = this.openTagBuffer.slice(openLen);
        this.openTagBuffer = "";
        this.inThinkTag = true;
        this.thinkOpenStripped = true;
        if (afterOpen) {
          out.push(...this.routeChunk(afterOpen));
        }
        return out;
      }
      const bufferedStart = this.openTagBuffer.trimStart();
      const attrPending = THINK_OPEN_ATTR_PARTIAL_RE.test(bufferedStart.toLowerCase());
      const overLimit = attrPending ? this.openTagBuffer.length > MAX_THINK_OPEN_ATTR_LEN : this.openTagBuffer.length > MAX_THINK_OPEN_LEN;
      if (overLimit || !isThinkOpenPrefix(bufferedStart)) {
        const buffered = this.openTagBuffer;
        this.openTagBuffer = "";
        this.openTagAbandoned = true;
        out.push(...this.routeChunk(buffered));
        return out;
      }
      return out;
    }
    if (this.thinkingModel && !this.firstContentSent && !this.inThinkTag && !this.inReasoningProse && stripped.toLowerCase().startsWith("</think")) {
      chunk = `${REDACTED_THINKING_OPEN}${chunk}`;
      this.inThinkTag = true;
    }
    if (this.inThinkTag) {
      const close = findThinkClose(chunk);
      if (close) {
        let thinkPart = chunk.slice(0, close.index);
        if (!this.thinkOpenStripped) {
          thinkPart = stripThinkOpenTag(thinkPart);
          this.thinkOpenStripped = true;
        }
        const regularPart = chunk.slice(close.index + close.length);
        this.inThinkTag = false;
        this.thinkOpenStripped = false;
        if (thinkPart) {
          out.push([thinkPart, true]);
        }
        if (regularPart) {
          if (!startsWithStandaloneThinkOpen(regularPart)) {
            this.firstContentSent = true;
          }
          out.push(...this.routeChunk(regularPart));
        }
      } else {
        if (!this.thinkOpenStripped) {
          chunk = stripThinkOpenTag(stripped);
          this.thinkOpenStripped = true;
        }
        if (chunk) {
          out.push([chunk, true]);
        }
      }
      return out;
    }
    if (!this.firstContentSent && !this.inReasoningProse && (startsWithReasoningPrefix(stripped) || THINKING_PREFIX_RE.test(stripped)) && !isThinkOpenPrefix(stripped)) {
      this.inReasoningProse = true;
      this.proseBuffer = chunk;
      const split = findReasoningProseSplit(this.proseBuffer);
      if (split) {
        out.push([split.thinking, true], [split.reply, false]);
        this.proseBuffer = "";
        this.inReasoningProse = false;
        this.firstContentSent = true;
      }
      return out;
    }
    if (this.inReasoningProse) {
      this.proseBuffer += chunk;
      const split = findReasoningProseSplit(this.proseBuffer);
      if (split) {
        out.push([split.thinking, true], [split.reply, false]);
        this.proseBuffer = "";
        this.inReasoningProse = false;
        this.firstContentSent = true;
      }
      return out;
    }
    if (this.thinkingModel && this.firstContentSent && !this.inThinkTag && !this.inReasoningProse) {
      const open = findStandaloneThinkOpen(chunk);
      if (open) {
        const before = chunk.slice(0, open.index);
        if (before) {
          out.push([before, false]);
        }
        this.midStreamThinkBuffer = chunk.slice(open.index);
        out.push(...this.drainMidStreamThink());
        return out;
      }
    }
    this.firstContentSent = true;
    out.push([chunk, false]);
    return out;
  }
}
function harmonySuffixHoldLen(text) {
  const limit = Math.min(text.length, HARMONY_MAX_MARKER_LEN - 1);
  for (let n = limit; n > 0; n -= 1) {
    const suffix = text.slice(-n);
    if (HARMONY_MARKERS.some((marker) => marker.startsWith(suffix))) {
      return n;
    }
  }
  return 0;
}
class HarmonyChannelRouter {
  buffer = "";
  seenHarmony = false;
  channel = null;
  inMessage = false;
  /** Commentary-channel text (tool-call headers + JSON) for post-stream parsing. */
  commentaryParseText = "";
  feed(text) {
    if (!text) {
      return [];
    }
    this.buffer += text;
    return this.drain(false);
  }
  flush() {
    return this.drain(true);
  }
  /** Buffered Harmony commentary segments (tool-call payloads). */
  getCommentaryParseText() {
    return this.commentaryParseText;
  }
  peekStreamingToolName() {
    const segment = this.commentaryParseText.slice(this.commentaryParseText.lastIndexOf("<|channel|>commentary"));
    const match = /\bto=([^\s<|]+)(?=[\s<|])/.exec(segment);
    return match ? normalizeHarmonyToolName(match[1]) : "";
  }
  appendText(out, text) {
    if (!text) {
      return;
    }
    if (!this.seenHarmony) {
      out.push([text, false]);
      return;
    }
    if (this.channel === "commentary") {
      this.commentaryParseText += text;
      return;
    }
    if (this.inMessage) {
      out.push([text, this.channel === "analysis"]);
    }
  }
  handleMarker(match) {
    const marker = match[0];
    this.seenHarmony = true;
    if (marker.startsWith("<|channel|>")) {
      this.channel = match[1] ?? null;
      if (this.channel === "commentary") this.commentaryParseText += marker;
      this.inMessage = false;
      return;
    }
    if (marker === "<|message|>") {
      if (this.channel === "commentary") this.commentaryParseText += marker;
      this.inMessage = true;
      return;
    }
    this.inMessage = false;
    if (marker === "<|end|>" || marker === "<|return|>" || marker === "<|call|>") {
      this.channel = null;
    }
  }
  drain(final) {
    const out = [];
    while (true) {
      const match = HARMONY_MARKER_RE.exec(this.buffer);
      if (!match) {
        break;
      }
      this.appendText(out, this.buffer.slice(0, match.index));
      this.handleMarker(match);
      this.buffer = this.buffer.slice(match.index + match[0].length);
    }
    const hold = final ? 0 : harmonySuffixHoldLen(this.buffer);
    const emit = hold === 0 ? this.buffer : this.buffer.slice(0, -hold);
    this.buffer = hold === 0 ? "" : this.buffer.slice(-hold);
    this.appendText(out, emit);
    return out;
  }
}
export {
  HarmonyChannelRouter,
  InlineContentThinkingRouter,
  extractInlineThinkingFromContent,
  modelLikelyUsesInlineThinking,
  normalizeThinkingMarkup
};
