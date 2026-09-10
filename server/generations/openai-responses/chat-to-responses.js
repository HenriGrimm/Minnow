/**
 * Map OpenAI Chat Completions JSON to OpenAI Responses (`/v1/responses`).
 * Minnow's runner still speaks chat/completions; Go Responses models need this wire shape.
 */

import { isMuseSparkModel } from '../../../src/lib/openai-responses-route.mjs';

/**
 * Flatten OpenAI message content into plain text.
 *
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
 * Image URL from an OpenAI image_url content part.
 *
 * @param {unknown} imageUrl
 * @returns {string}
 */
function imageUrlFromPart(imageUrl) {
  if (typeof imageUrl === 'string') return imageUrl.trim();
  if (imageUrl && typeof imageUrl === 'object' && typeof imageUrl.url === 'string') {
    return imageUrl.url.trim();
  }
  return '';
}

/**
 * User/system content as Responses input parts (text + images).
 *
 * @param {unknown} content
 * @returns {string | Array<Record<string, unknown>>}
 */
function userInputFromOpenAi(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  /** @type {Array<Record<string, unknown>>} */
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'input_text', text: part.text });
      continue;
    }
    if (part.type === 'image_url') {
      const url = imageUrlFromPart(part.image_url);
      if (url) {
        parts.push({ type: 'input_image', image_url: url });
      }
    }
  }
  if (parts.length === 0) return '';
  if (parts.length === 1 && parts[0].type === 'input_text') {
    return /** @type {string} */ (parts[0].text);
  }
  return parts;
}

/**
 * @param {unknown} tools
 * @returns {Array<Record<string, unknown>> | undefined}
 */
function mapTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const mapped = [];
  for (const entry of tools) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'function' && typeof entry.name === 'string' && entry.name.trim()) {
      mapped.push({
        type: 'function',
        name: entry.name.trim(),
        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        parameters:
          entry.parameters && typeof entry.parameters === 'object'
            ? entry.parameters
            : { type: 'object', properties: {} },
      });
      continue;
    }
    const fn = entry.function;
    if (entry.type !== 'function' || !fn || typeof fn !== 'object') continue;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    mapped.push({
      type: 'function',
      name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      parameters:
        fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
    });
  }
  return mapped.length > 0 ? mapped : undefined;
}

/**
 * @param {unknown} toolChoice
 * @returns {unknown}
 */
function mapToolChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
    return toolChoice;
  }
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    const fn = toolChoice.function;
    const name =
      (fn && typeof fn === 'object' && typeof fn.name === 'string' && fn.name.trim()) ||
      (typeof toolChoice.name === 'string' ? toolChoice.name.trim() : '');
    if (name) return { type: 'function', name };
  }
  return undefined;
}

/**
 * Pi / OpenCode effort names for Responses `reasoning.effort`.
 *
 * @param {Record<string, unknown>} body
 * @returns {{ effort: string } | undefined}
 */
function mapReasoning(body) {
  const museSpark = typeof body.model === 'string' && isMuseSparkModel(body.model);
  const thinking = body.thinking;
  if (thinking && typeof thinking === 'object') {
    const type = /** @type {{ type?: string }} */ (thinking).type;
    // Muse Spark rejects `none`; its minimum supported effort keeps utility
    // generations (expanders, commit messages, issue helpers) producing prose.
    if (type === 'disabled') return museSpark ? { effort: 'low' } : { effort: 'none' };
  }
  const fromEffort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.trim() : '';
  const nested =
    body.reasoning && typeof body.reasoning === 'object'
      ? /** @type {{ effort?: unknown }} */ (body.reasoning).effort
      : undefined;
  const raw = fromEffort || (typeof nested === 'string' ? nested.trim() : '');
  if (!raw) return undefined;
  if (raw === 'off' || raw === 'none') return museSpark ? { effort: 'low' } : { effort: 'none' };
  return { effort: raw };
}

/**
 * Convert Chat Completions JSON to a Responses request body.
 *
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
export function chatCompletionBodyToResponses(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  /** @type {string[]} */
  const instructionParts = [];
  /** @type {Array<Record<string, unknown>>} */
  const input = [];

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = /** @type {Record<string, unknown>} */ (raw);
    const role = typeof msg.role === 'string' ? msg.role : '';

    if (role === 'system' || role === 'developer') {
      const text = textFromContent(msg.content).trim();
      if (text) instructionParts.push(text);
      continue;
    }

    if (role === 'tool') {
      const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id.trim() : '';
      if (!callId) continue;
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: textFromContent(msg.content) || '',
      });
      continue;
    }

    if (role === 'assistant') {
      const text = textFromContent(msg.content);
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const call of toolCalls) {
        if (!call || typeof call !== 'object') continue;
        const id = typeof call.id === 'string' ? call.id.trim() : '';
        const fn = call.function && typeof call.function === 'object' ? call.function : {};
        const name = typeof fn.name === 'string' ? fn.name.trim() : '';
        if (!id || !name) continue;
        input.push({
          type: 'function_call',
          call_id: id,
          name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
        });
      }
      continue;
    }

    const content = userInputFromOpenAi(msg.content);
    if (content === '' || (Array.isArray(content) && content.length === 0)) continue;
    input.push({
      type: 'message',
      role: 'user',
      content,
    });
  }

  /** @type {Record<string, unknown>} */
  const next = {
    model: typeof body.model === 'string' ? body.model : '',
    input,
    stream: body.stream === true,
  };

  if (instructionParts.length > 0) {
    next.instructions = instructionParts.join('\n\n');
  }

  const tools = mapTools(body.tools);
  if (tools) next.tools = tools;
  const toolChoice = mapToolChoice(body.tool_choice);
  if (toolChoice !== undefined) next.tool_choice = toolChoice;

  const maxOutput =
    typeof body.max_output_tokens === 'number'
      ? body.max_output_tokens
      : typeof body.max_completion_tokens === 'number'
        ? body.max_completion_tokens
        : typeof body.max_tokens === 'number'
          ? body.max_tokens
          : undefined;
  if (typeof maxOutput === 'number') next.max_output_tokens = maxOutput;

  if (typeof body.temperature === 'number') next.temperature = body.temperature;
  if (typeof body.top_p === 'number') next.top_p = body.top_p;

  const reasoning = mapReasoning(body);
  if (reasoning) next.reasoning = reasoning;

  return next;
}

/**
 * Pull reasoning summary text from a Responses reasoning item.
 *
 * @param {Record<string, unknown>} item
 * @returns {string}
 */
function reasoningTextFromItem(item) {
  const summary = item.summary;
  if (Array.isArray(summary)) {
    return summary
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  if (typeof item.content === 'string') return item.content;
  return '';
}

/**
 * Convert a Responses JSON object into an OpenAI chat.completion payload.
 * Already-OpenAI bodies pass through so probes/research can share one extractor.
 *
 * @param {unknown} data
 * @param {string} [modelId]
 * @returns {Record<string, unknown>}
 */
export function responsesJsonToOpenAiCompletion(data, modelId) {
  if (!data || typeof data !== 'object') {
    throw new Error('Unexpected completion response schema');
  }
  const record = /** @type {Record<string, unknown>} */ (data);
  if (Array.isArray(record.choices)) {
    return record;
  }

  const output = Array.isArray(record.output) ? record.output : [];
  let text = typeof record.output_text === 'string' ? record.output_text : '';
  let reasoning = '';
  /** @type {Array<Record<string, unknown>>} */
  const toolCalls = [];

  for (const raw of output) {
    if (!raw || typeof raw !== 'object') continue;
    const item = /** @type {Record<string, unknown>} */ (raw);
    if (item.type === 'message') {
      const parts = Array.isArray(item.content) ? item.content : [];
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (
          (part.type === 'output_text' || part.type === 'text') &&
          typeof part.text === 'string'
        ) {
          text += part.text;
        }
      }
      continue;
    }
    if (item.type === 'reasoning') {
      reasoning += reasoningTextFromItem(item);
      continue;
    }
    if (item.type === 'function_call') {
      const callId =
        (typeof item.call_id === 'string' && item.call_id.trim()) ||
        (typeof item.id === 'string' ? item.id.trim() : '');
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!callId || !name) continue;
      toolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name,
          arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
        },
      });
    }
  }

  const usageRaw = record.usage && typeof record.usage === 'object' ? record.usage : null;
  const usage = usageRaw
    ? {
        prompt_tokens:
          typeof usageRaw.input_tokens === 'number' ? usageRaw.input_tokens : undefined,
        completion_tokens:
          typeof usageRaw.output_tokens === 'number' ? usageRaw.output_tokens : undefined,
        total_tokens:
          typeof usageRaw.total_tokens === 'number'
            ? usageRaw.total_tokens
            : typeof usageRaw.input_tokens === 'number' && typeof usageRaw.output_tokens === 'number'
              ? usageRaw.input_tokens + usageRaw.output_tokens
              : undefined,
      }
    : undefined;

  const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  /** @type {Record<string, unknown>} */
  const message = {
    role: 'assistant',
    content: text,
  };
  if (reasoning) message.reasoning = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: typeof record.id === 'string' ? record.id : 'chatcmpl-responses',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof record.model === 'string' ? record.model : modelId || '',
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}
