import { outboundReasoningReplayFields } from "./reasoning.js";
import { isUiOnlyTranscriptMessage } from "./injection-notice.js";
import { toolImageFollowUpUserMessage } from "./tool-image-follow-up.js";
function replayedReasoningFields(m, options) {
  if (!options?.replayPriorReasoning) return null;
  const reasoningText = m.thinking?.join("\n\n").trim() ?? "";
  if (!reasoningText) return null;
  const fields = outboundReasoningReplayFields(options.modelId ?? "", reasoningText);
  return Object.keys(fields).length > 0 ? fields : null;
}
const CHARS_PER_TOKEN = {
  prose: 3.6,
  payload: 3,
  schema: 4
};
function charsPerTokenFor(kind) {
  return CHARS_PER_TOKEN[kind];
}
function estimateTokensFromText(text, kind = "prose") {
  if (!text) return 0;
  return Math.round(text.length / CHARS_PER_TOKEN[kind]);
}
const ESTIMATE_IMAGE_URL_TOKENS = 1400;
const PIXELS_PER_IMAGE_TOKEN = 750;
const MIN_IMAGE_URL_TOKENS = 85;
const MAX_IMAGE_URL_TOKENS = 16384;
const JPEG_SCAN_BYTES = 65536;
const IMAGE_TOKEN_CACHE_LIMIT = 512;
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** @type {Int16Array | null} */
let b64Lookup = null;
function base64Lookup() {
  if (b64Lookup) return b64Lookup;
  b64Lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    b64Lookup[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return b64Lookup;
}
/**
 * Decode the first `maxBytes` of a base64 payload. Portable on purpose: this
 * module runs in the browser and in Node tests, so no `atob` / `Buffer`.
 * Non-alphabet characters (padding, whitespace, url-safe strays) are skipped.
 */
function decodeBase64Prefix(b64, maxBytes) {
  const lookup = base64Lookup();
  const out = new Uint8Array(maxBytes);
  let len = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < b64.length && len < maxBytes; i += 1) {
    const code = b64.charCodeAt(i);
    const value = code < 128 ? lookup[code] : -1;
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[len] = (buffer >> bits) & 255;
      len += 1;
    }
  }
  return out.subarray(0, len);
}
function readU32BE(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}
function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 255) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) {
      offset += 2;
      continue;
    }
    const size = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (size < 2) break;
    // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8]
      };
    }
    offset += 2 + size;
  }
  return null;
}
function webpDimensions(bytes) {
  const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (tag === "VP8 " && bytes.length >= 30) {
    return {
      width: ((bytes[26] | (bytes[27] << 8)) & 16383),
      height: ((bytes[28] | (bytes[29] << 8)) & 16383)
    };
  }
  if (tag === "VP8L" && bytes.length >= 25) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 };
  }
  if (tag === "VP8X" && bytes.length >= 30) {
    return {
      width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
      height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1
    };
  }
  return null;
}
/** Intrinsic pixel size from a decoded image header (PNG, JPEG, GIF, WebP). */
function imageDimensionsFromBytes(bytes) {
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
  }
  if (bytes.length >= 10 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) {
    return {
      width: bytes[6] | (bytes[7] << 8),
      height: bytes[8] | (bytes[9] << 8)
    };
  }
  if (
    bytes.length >= 16 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 &&
    bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80
  ) {
    return webpDimensions(bytes);
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    return jpegDimensions(bytes);
  }
  return null;
}
/** Intrinsic pixel size of a `data:image/*;base64,...` URL, or null. */
function imageDimensionsFromDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  // Only base64 payloads are decodable here; percent-encoded SVG data URLs are not.
  if (!dataUrl.slice(0, comma).endsWith(";base64")) return null;
  const payload = dataUrl.slice(comma + 1);
  if (!payload) return null;
  // PNG/GIF/WebP need only the first bytes; JPEG may carry an EXIF thumbnail
  // ahead of its SOF segment, so give it a bounded scan.
  const isJpeg = dataUrl.startsWith("data:image/jpeg") || dataUrl.startsWith("data:image/jpg");
  const bytes = decodeBase64Prefix(payload, isJpeg ? JPEG_SCAN_BYTES : 64);
  const dims = imageDimensionsFromBytes(bytes);
  if (!dims) return null;
  if (!Number.isFinite(dims.width) || !Number.isFinite(dims.height)) return null;
  if (dims.width <= 0 || dims.height <= 0) return null;
  return dims;
}
/** @type {Map<string, number>} */
const imageTokenCache = new Map();
function imageTokenCacheKey(dataUrl) {
  return `${dataUrl.length}:${dataUrl.slice(0, 64)}`;
}
/**
 * Token cost of one `image_url` part, priced from the image's real pixel count.
 *
 * A flat per-image constant is what made the context wheel lie: modern VLMs bill
 * vision by patch count, so an unresized Retina screenshot (~2.9 MP) costs
 * thousands of tokens, not a couple hundred. `PIXELS_PER_IMAGE_TOKEN` is the
 * cross-model proxy (GPT-4o, Claude and Qwen-VL style patching all land within a
 * few percent of it). Falls back to {@link ESTIMATE_IMAGE_URL_TOKENS} when the
 * header cannot be read — a remote URL, or a format we do not parse.
 */
function estimateImageUrlTokens(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl) return ESTIMATE_IMAGE_URL_TOKENS;
  const key = imageTokenCacheKey(dataUrl);
  const cached = imageTokenCache.get(key);
  if (cached !== void 0) return cached;
  const dims = imageDimensionsFromDataUrl(dataUrl);
  const tokens = dims
    ? Math.min(
      MAX_IMAGE_URL_TOKENS,
      Math.max(MIN_IMAGE_URL_TOKENS, Math.round((dims.width * dims.height) / PIXELS_PER_IMAGE_TOKEN))
    )
    : ESTIMATE_IMAGE_URL_TOKENS;
  if (imageTokenCache.size >= IMAGE_TOKEN_CACHE_LIMIT) {
    const oldest = imageTokenCache.keys().next().value;
    if (oldest !== void 0) imageTokenCache.delete(oldest);
  }
  imageTokenCache.set(key, tokens);
  return tokens;
}
/** Summed token cost of every `image_url` part in a message. */
function estimateImageUrlsTokens(dataUrls) {
  let total = 0;
  for (const url of dataUrls) total += estimateImageUrlTokens(url);
  return total;
}
function imagePaddingForEstimate(dataUrls) {
  if (!dataUrls?.length) return "";
  const tokens = estimateImageUrlsTokens(dataUrls);
  if (tokens <= 0) return "";
  return " ".repeat(Math.round(tokens * CHARS_PER_TOKEN.prose));
}
function formatTokenEstimateLabel(tokens) {
  if (!Number.isFinite(tokens) || tokens < 0) return "\u2014";
  if (tokens >= 1e3) {
    return `~${(tokens / 1e3).toFixed(1)}k tokens (estimate)`;
  }
  return `~${tokens.toLocaleString()} tokens (estimate)`;
}
const TOKEN_ESTIMATE_TOOLTIP = "Approximate size from character counts calibrated per content type. Real prompt tokens depend on the model tokenizer. Excludes pending composer text and attachments.";
const SETTINGS_PROMPT_CONFIG_ESTIMATE_TOOLTIP = "Approximate system prompt, rules, and tools from character counts calibrated per content type. Excludes chat history, pending composer text, and attachments.";
function historyToApiMessagesForEstimate(history, options) {
  const messages = [];
  for (const m of history) {
    if (isUiOnlyTranscriptMessage(m)) continue;
    if (m.role === "user") {
      const images = m.images ?? [];
      if (images.length > 0) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...images.map((image) => ({
              type: "image_url",
              image_url: { url: image.dataUrl, detail: "auto" }
            }))
          ]
        });
        continue;
      }
      messages.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: m.tool_call_id,
        content: m.content
      });
      const followUp = toolImageFollowUpUserMessage(m);
      if (followUp) messages.push(followUp);
      continue;
    }
    if (m.role === "assistant") {
      const withTools = m;
      if (withTools.tool_calls?.length) {
        messages.push({
          role: "assistant",
          content: withTools.content ?? null,
          tool_calls: withTools.tool_calls
        });
      } else {
        const replayed = replayedReasoningFields(m, options);
        messages.push({
          role: "assistant",
          content: m.content,
          ...replayed ?? {}
        });
      }
    }
  }
  return messages;
}
function serializeMessageContentForEstimate(m, options) {
  if (m.role === "user") {
    const images = m.images ?? [];
    if (images.length === 0) return m.content;
    return m.content + imagePaddingForEstimate(images.map((image) => image.dataUrl));
  }
  if (m.role === "tool") return m.content;
  if (m.role === "assistant") {
    const withTools = m;
    if (withTools.tool_calls?.length) {
      const content = withTools.content ?? "";
      return content + JSON.stringify(withTools.tool_calls);
    }
    const replayed = replayedReasoningFields(m, options);
    return (m.content ?? "") + (replayed ? JSON.stringify(replayed) : "");
  }
  return "";
}
function estimateMessageTokens(m, options) {
  if (m.role === "user") {
    const images = m.images ?? [];
    return estimateTokensFromText(m.content, "prose") + estimateImageUrlsTokens(images.map((image) => image.dataUrl));
  }
  if (m.role === "tool") return estimateTokensFromText(m.content, "payload");
  if (m.role === "assistant") {
    const withTools = m;
    let total = estimateTokensFromText(withTools.content ?? "", "prose");
    if (withTools.tool_calls?.length) {
      return total + estimateTokensFromText(JSON.stringify(withTools.tool_calls), "payload");
    }
    const replayed = replayedReasoningFields(m, options);
    if (replayed) total += estimateTokensFromText(JSON.stringify(replayed), "prose");
    return total;
  }
  return 0;
}
function estimateHistoryTokens(history, options) {
  let total = 0;
  for (const m of history) {
    if (isUiOnlyTranscriptMessage(m)) continue;
    total += estimateMessageTokens(m, options);
  }
  return total;
}
function estimateToolsTokens(tools) {
  if (tools.length === 0) return 0;
  return estimateTokensFromText(JSON.stringify(tools), "schema");
}
function computePromptConfigTokenTotal(est) {
  return est.composedSystem + est.userRules + est.tools;
}
function computeOutboundPromptEstimateFromParts(parts) {
  const composedSystem = estimateTokensFromText(parts.systemText.trim());
  const userRules = estimateTokensFromText(parts.userRulesText?.trim() ?? "");
  const history = estimateHistoryTokens(parts.history);
  const tools = estimateToolsTokens(parts.tools);
  return {
    total: composedSystem + userRules + history + tools,
    composedSystem,
    userRules,
    history,
    tools,
  };
}
export {
  ESTIMATE_IMAGE_URL_TOKENS,
  PIXELS_PER_IMAGE_TOKEN,
  estimateImageUrlTokens,
  estimateImageUrlsTokens,
  imageDimensionsFromDataUrl,
  SETTINGS_PROMPT_CONFIG_ESTIMATE_TOOLTIP,
  TOKEN_ESTIMATE_TOOLTIP,
  charsPerTokenFor,
  computeOutboundPromptEstimateFromParts,
  computePromptConfigTokenTotal,
  estimateHistoryTokens,
  estimateMessageTokens,
  estimateTokensFromText,
  estimateToolsTokens,
  formatTokenEstimateLabel,
  historyToApiMessagesForEstimate,
  imagePaddingForEstimate,
  serializeMessageContentForEstimate
};
