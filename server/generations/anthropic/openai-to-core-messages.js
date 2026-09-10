/**
 * Convert Minnow OpenAI-shaped chat messages to AI SDK ModelMessage[].
 */

import { anthropicReasoningBlocks } from '../../../src/lib/anthropic-reasoning.mjs';

/** @typedef {import('@ai-sdk/provider-utils').ModelMessage} ModelMessage */

/**
 * @param {unknown} content
 * @returns {string}
 */
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {unknown} content
 * @returns {import('@ai-sdk/provider-utils').UserContent}
 */
function userContentFromOpenAi(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  /** @type {Array<import('@ai-sdk/provider-utils').TextPart | import('@ai-sdk/provider-utils').ImagePart>} */
  const parts = [];

  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url' && part.image_url) {
      const url =
        typeof part.image_url === 'string'
          ? part.image_url
          : typeof part.image_url.url === 'string'
            ? part.image_url.url
            : '';
      if (url) {
        parts.push({
          type: 'image',
          image: url,
          ...(typeof part.image_url.detail === 'string'
            ? { providerOptions: { openai: { imageDetail: part.image_url.detail } } }
            : {}),
        });
      }
    }
  }

  if (parts.length === 0) return '';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parseToolArguments(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Build tool_call_id → tool name lookup from assistant messages.
 * @param {Array<Record<string, unknown>>} messages
 * @returns {Map<string, string>}
 */
function buildToolNameLookup(messages) {
  /** @type {Map<string, string>} */
  const lookup = new Map();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const call of msg.tool_calls) {
      if (!call || typeof call !== 'object') continue;
      const id = typeof call.id === 'string' ? call.id : '';
      const name =
        call.function && typeof call.function === 'object' && typeof call.function.name === 'string'
          ? call.function.name
          : '';
      if (id && name) lookup.set(id, name);
    }
  }
  return lookup;
}

/**
 * AI SDK tool results must be structured ToolResultOutput, not a raw string.
 * @param {Record<string, unknown>} msg
 * @param {Map<string, string>} toolNames
 * @returns {ModelMessage}
 */
function convertMessage(msg, toolNames) {
  const role = msg.role;

  if (role === 'user') {
    return {
      role: 'user',
      content: userContentFromOpenAi(msg.content),
    };
  }

  if (role === 'assistant') {
    /** @type {import('@ai-sdk/provider-utils').AssistantContent} */
    const contentParts = [];
    const blocks = anthropicReasoningBlocks(msg.reasoning_blocks);
    for (const block of blocks) {
      contentParts.push({
        type: 'reasoning',
        text: block.type === 'thinking' ? block.thinking : '',
        providerOptions: { anthropic: block.type === 'thinking'
          ? { signature: block.signature } : { redactedData: block.data } },
      });
    }
    const reasoningText = typeof msg.reasoning === 'string' ? msg.reasoning : '';
    const reasoningSignature =
      typeof msg.reasoning_signature === 'string' ? msg.reasoning_signature.trim() : '';
    if (blocks.length === 0 && reasoningSignature && reasoningText) {
      contentParts.push({
        type: 'reasoning',
        text: reasoningText,
        providerOptions: {
          anthropic: {
            signature: reasoningSignature,
          },
        },
      });
    }

    const text = textFromContent(msg.content);
    if (text) {
      contentParts.push({ type: 'text', text });
    }

    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        const toolCallId = typeof call.id === 'string' ? call.id : '';
        const toolName =
          call.function && typeof call.function === 'object' && typeof call.function.name === 'string'
            ? call.function.name
            : '';
        if (!toolCallId || !toolName) continue;
        contentParts.push({
          type: 'tool-call',
          toolCallId,
          toolName,
          input: parseToolArguments(
            call.function && typeof call.function.arguments === 'string'
              ? call.function.arguments
              : '',
          ),
        });
      }
    }

    if (contentParts.length === 0) {
      return { role: 'assistant', content: '' };
    }
    if (contentParts.length === 1 && contentParts[0].type === 'text') {
      return { role: 'assistant', content: contentParts[0].text };
    }
    return { role: 'assistant', content: contentParts };
  }

  if (role === 'tool') {
    const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
    const toolName = toolNames.get(toolCallId) || 'unknown_tool';
    const outputText =
      typeof msg.content === 'string'
        ? msg.content
        : textFromContent(msg.content) || JSON.stringify(msg.content ?? '');

    return {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName,
          output: { type: 'text', value: outputText },
        },
      ],
    };
  }

  return {
    role: 'system',
    content: textFromContent(msg.content),
  };
}

/**
 * Fold consecutive leading system messages into one system ModelMessage.
 * @param {Array<Record<string, unknown>>} messages
 * @returns {ModelMessage[]}
 */
function foldLeadingSystemMessages(messages) {
  /** @type {string[]} */
  const leadingSystem = [];
  let index = 0;

  while (index < messages.length && messages[index]?.role === 'system') {
    leadingSystem.push(textFromContent(messages[index].content));
    index += 1;
  }

  /** @type {ModelMessage[]} */
  const out = [];
  if (leadingSystem.length > 0) {
    out.push({
      role: 'system',
      content: leadingSystem.filter(Boolean).join('\n\n'),
    });
  }

  const toolNames = buildToolNameLookup(messages.slice(index));
  for (; index < messages.length; index += 1) {
    const msg = messages[index];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'system') {
      out.push({ role: 'system', content: textFromContent(msg.content) });
      continue;
    }
    out.push(convertMessage(msg, toolNames));
  }

  return out;
}

/**
 * @param {unknown} openAiMessages
 * @returns {ModelMessage[]}
 */
export function openAiMessagesToCoreMessages(openAiMessages) {
  if (!Array.isArray(openAiMessages)) return [];
  const normalized = openAiMessages.filter((msg) => msg && typeof msg === 'object');
  return foldLeadingSystemMessages(/** @type {Array<Record<string, unknown>>} */ (normalized));
}
