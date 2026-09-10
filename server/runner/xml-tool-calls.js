import { extractBalancedJsonObject } from "./harmony-tool-calls.js";
const TOOL_CALL_TAG_NAMES = ["tool_call", "tool_use", "function_call"];
const TOOL_CALL_OPEN_TAGS = TOOL_CALL_TAG_NAMES.map((name) => `<${name}>`);
const TOOL_CALL_CLOSE_TAGS = TOOL_CALL_TAG_NAMES.map((name) => `</${name}>`);
const TOOL_CALL_TAGS = [...TOOL_CALL_OPEN_TAGS, ...TOOL_CALL_CLOSE_TAGS];
const MAX_TOOL_CALL_TAG_LEN = Math.max(...TOOL_CALL_TAGS.map((tag) => tag.length));
const TOOL_CALL_MARKER_RE = new RegExp(`</?(?:${TOOL_CALL_TAG_NAMES.join("|")})>`, "i");
const TOOL_CALL_BLOCK_RE = new RegExp(
  `<(${TOOL_CALL_TAG_NAMES.join("|")})>([\\s\\S]*?)(?:</\\1>|$)`,
  "gi"
);
const CANONICAL_OPEN = `<${TOOL_CALL_TAG_NAMES[0]}>`;
const CANONICAL_CLOSE = `</${TOOL_CALL_TAG_NAMES[0]}>`;
function syntheticXmlToolCallId(index) {
  return `call_xml_${index}`;
}
function isOpenTag(marker) {
  return !marker.startsWith("</");
}
const QWEN_FUNCTION_OPEN_RE = /<function=([^>\s]+)\s*>/i;
// A parameter value ends at its own close tag, at the next parameter, at the end
// of the function envelope, or at end of input. The last three matter because
// models routinely omit `</parameter>`: with only `</parameter>|$` as
// terminators, the first parameter of an unclosed envelope swallows every
// parameter after it, and the call arrives with one key holding all the markup.
// Lookahead, not consumption, so the next `<parameter=` is still there to match.
const QWEN_PARAMETER_RE =
  /<parameter=([^>\s]+)\s*>([\s\S]*?)(?=<\/parameter>|<parameter=|<\/function>|$)/gi;
/** JSON-decode a Qwen XML parameter when the model wrote an object/array/number; otherwise keep the string. */
function coerceQwenParameterValue(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
/**
 * True when parsed JSON is already an OpenAI-style tool envelope.
 * Those stay on `parseJsonToolCallPayload` so we do not treat `{name,arguments}`
 * as the arguments object of the surrounding `<function=name>`.
 * @param {unknown} parsed
 * @returns {boolean}
 */
function isJsonToolCallEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed;
  const fn = record.function;
  const topName = typeof record.name === "string" && record.name.trim();
  const nestedName =
    fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string" && fn.name.trim();
  const hasArgs =
    record.arguments !== void 0 ||
    record.parameters !== void 0 ||
    (fn && typeof fn === "object" && !Array.isArray(fn) && (fn.arguments !== void 0 || fn.parameters !== void 0));
  return Boolean((topName || nestedName) && hasArgs);
}

/**
 * Qwen3.5 / Qwen3.8 / Qwen3-Coder native envelope (MTPLX, vLLM qwen3_coder):
 * `<function=name><parameter=key>\nvalue\n</parameter></function>`
 * Missing close tags are still accepted so a stream cut mid-envelope can run.
 * mlx-lm / llama.cpp sometimes emit unwrapped JSON after `<function=name>`
 * instead of `<parameter=key>` tags — recover that as the arguments object.
 */
function parseQwenXmlFunctionPayload(inner) {
  const fnMatch = QWEN_FUNCTION_OPEN_RE.exec(inner);
  if (!fnMatch) return null;
  const name = fnMatch[1].trim();
  if (!name) return null;
  const args = {};
  QWEN_PARAMETER_RE.lastIndex = 0;
  let param = QWEN_PARAMETER_RE.exec(inner);
  let hadParameter = false;
  while (param) {
    hadParameter = true;
    const key = (param[1] ?? "").trim();
    if (key) {
      args[key] = coerceQwenParameterValue(param[2] ?? "");
    }
    param = QWEN_PARAMETER_RE.exec(inner);
  }
  if (!hadParameter) {
    const json = extractBalancedJsonObject(inner, fnMatch.index + fnMatch[0].length);
    if (json) {
      try {
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !isJsonToolCallEnvelope(parsed)) {
          return { name, args: parsed };
        }
      } catch {
        // Keep empty args — the markup reached us but the JSON did not parse.
      }
    }
  }
  return { name, args };
}
function parseJsonToolCallPayload(inner, index) {
  const json = extractBalancedJsonObject(inner, 0);
  if (!json) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed;
  const fn = record.function;
  let name = typeof record.name === "string" ? record.name.trim() : "";
  let args = record.arguments ?? record.parameters;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const fnRecord = fn;
    if (!name && typeof fnRecord.name === "string") {
      name = fnRecord.name.trim();
    }
    if (args === void 0) {
      args = fnRecord.arguments ?? fnRecord.parameters;
    }
  }
  if (!name) {
    return null;
  }
  const argumentsJson = typeof args === "string" ? args : args === void 0 ? "{}" : JSON.stringify(args);
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : syntheticXmlToolCallId(index);
  return { id, type: "function", function: { name, arguments: argumentsJson } };
}
function parseToolCallPayload(inner, index) {
  const fromJson = parseJsonToolCallPayload(inner, index);
  if (fromJson) return fromJson;
  const fromXml = parseQwenXmlFunctionPayload(inner);
  if (!fromXml) return null;
  return {
    id: syntheticXmlToolCallId(index),
    type: "function",
    function: { name: fromXml.name, arguments: JSON.stringify(fromXml.args) }
  };
}
/** Best-effort tool name from a still-open `<tool_call>` capture (for "Calling {tool}…"). */
function peekToolCallName(haystack) {
  if (!haystack) return "";
  const parsed = parseToolCallPayload(haystack, 0);
  if (parsed?.function?.name) return parsed.function.name;
  const fn = QWEN_FUNCTION_OPEN_RE.exec(haystack);
  if (fn?.[1]) return fn[1].trim();
  const jsonName = /"name"\s*:\s*"([^"]+)"/.exec(haystack);
  return jsonName?.[1]?.trim() ?? "";
}
function hasXmlToolCallMarkup(text) {
  return Boolean(text) && (TOOL_CALL_MARKER_RE.test(text) || QWEN_FUNCTION_OPEN_RE.test(text));
}
function tryParseXmlToolCallsFromText(text) {
  if (!text || !hasXmlToolCallMarkup(text)) {
    return [];
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  function pushParsed(parsed) {
    if (!parsed) return;
    const dedupeKey = `${parsed.function.name}\0${parsed.function.arguments}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push(parsed);
  }
  TOOL_CALL_BLOCK_RE.lastIndex = 0;
  let match = TOOL_CALL_BLOCK_RE.exec(text);
  while (match) {
    pushParsed(parseToolCallPayload(match[2] ?? "", out.length));
    match = TOOL_CALL_BLOCK_RE.exec(text);
  }
  // Bare `<function=name>` with no wrapping `<tool_call>` (some Qwen streams).
  if (out.length === 0) {
    pushParsed(parseToolCallPayload(text, 0));
  }
  return out;
}
function stripXmlToolCallBlocks(text) {
  if (!text || !hasXmlToolCallMarkup(text)) {
    return text;
  }
  return text.replace(TOOL_CALL_BLOCK_RE, "").trim();
}
function toolCallSuffixHoldLen(text) {
  const limit = Math.min(text.length, MAX_TOOL_CALL_TAG_LEN - 1);
  for (let n = limit; n > 0; n -= 1) {
    const suffix = text.slice(-n).toLowerCase();
    if (!suffix.startsWith("<")) {
      continue;
    }
    if (TOOL_CALL_TAGS.some((tag) => tag.startsWith(suffix))) {
      return n;
    }
  }
  return 0;
}
class ContentToolCallRouter {
  buffer = "";
  capturing = false;
  captured = "";
  /** Literal opener that started the current block, for verbatim replay. */
  capturedOpenTag = "";
  parseText = "";
  /** Visible prose for `text`, with tool-call markup withheld. */
  feed(text) {
    if (!text) {
      return "";
    }
    this.buffer += text;
    return this.drain(false);
  }
  /** Release held bytes; an unterminated block still counts as a call when it parses. */
  flush() {
    return this.drain(true);
  }
  /** Captured `<tool_call>` blocks, re-wrapped canonically for parsing. */
  getToolCallParseText() {
    return this.parseText;
  }
  /** True once a block on this stream parsed as a tool call. */
  hasCapturedToolCalls() {
    return this.parseText.length > 0;
  }
  /**
   * Name of a tool call already captured, or of the block currently streaming.
   * Empty until the envelope is unambiguous — used to leave the thinking timer.
   */
  peekStreamingToolName() {
    const fromClosed = peekToolCallName(this.parseText);
    if (fromClosed) return fromClosed;
    if (!this.capturing) return "";
    return peekToolCallName(this.captured + this.buffer);
  }
  /**
   * End the current block. Returns text to put back into prose when the payload
   * is not a tool call — a model explaining the format keeps its markup visible.
   */
  closeBlock(closeTag) {
    const raw = this.captured;
    const openTag = this.capturedOpenTag;
    this.captured = "";
    this.capturedOpenTag = "";
    this.capturing = false;
    const inner = raw.trim();
    if (inner && parseToolCallPayload(inner, 0)) {
      this.parseText += `${CANONICAL_OPEN}${inner}${CANONICAL_CLOSE}`;
      return "";
    }
    return `${openTag}${raw}${closeTag}`;
  }
  drain(final) {
    let visible = "";
    while (true) {
      const match = TOOL_CALL_MARKER_RE.exec(this.buffer);
      if (!match) {
        break;
      }
      const before = this.buffer.slice(0, match.index);
      if (this.capturing) {
        this.captured += before;
      } else {
        visible += before;
      }
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (isOpenTag(match[0])) {
        if (this.capturing) {
          visible += this.closeBlock("");
        }
        this.capturing = true;
        this.capturedOpenTag = match[0];
        continue;
      }
      if (this.capturing) {
        visible += this.closeBlock(match[0]);
      } else {
        visible += match[0];
      }
    }
    const hold = final ? 0 : toolCallSuffixHoldLen(this.buffer);
    const emit = hold === 0 ? this.buffer : this.buffer.slice(0, this.buffer.length - hold);
    this.buffer = hold === 0 ? "" : this.buffer.slice(this.buffer.length - hold);
    if (this.capturing) {
      this.captured += emit;
      if (final) {
        return visible + this.closeBlock("");
      }
      return visible;
    }
    return visible + emit;
  }
}
export {
  ContentToolCallRouter,
  hasXmlToolCallMarkup,
  stripXmlToolCallBlocks,
  tryParseXmlToolCallsFromText
};
