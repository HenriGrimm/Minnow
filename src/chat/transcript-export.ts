import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { Chat } from '../types';
import { apiMessageContentToText } from '../api/message-content';
import { escapeHtml } from '../lib/format-model-label';
import { isHiddenTranscriptUserMessage } from './hidden-transcript-user-messages';
import { transcriptExportStyles } from './transcript-export-styles';

interface TranscriptEntry {
  label: string;
  kind: 'user' | 'assistant' | 'activity';
  text: string;
  images?: { name: string; dataUrl: string }[];
}

/** Export the visible conversation and work, without internal prompts or reasoning. */
function transcriptEntries(chat: Chat): TranscriptEntry[] {
  if (chat.historyLoaded === false) throw new Error('Chat history has not loaded');
  const entries: TranscriptEntry[] = [];
  const toolNames = new Map<string, string>();
  for (const message of chat.history) {
    if (message.role === 'user') {
      if (isHiddenTranscriptUserMessage(message)) continue;
      const text = message.issue
        ? `${message.issue.id}: ${message.issue.title}\n\n${message.issue.description}`
        : message.codeMap
          ? `${message.codeMap.title}\n\n${message.codeMap.question}`
          : apiMessageContentToText(message.content);
      entries.push({ label: 'You', kind: 'user', text, images: message.images });
    } else if (message.role === 'assistant') {
      const text = apiMessageContentToText(message.content);
      if (text.trim()) entries.push({ label: 'Assistant', kind: 'assistant', text });
      if ('tool_calls' in message) {
        for (const call of message.tool_calls) {
          toolNames.set(call.id, call.function.name);
          entries.push({ label: `Tool call: ${call.function.name}`, kind: 'activity', text: call.function.arguments });
        }
      }
    } else if (message.role === 'tool') {
      entries.push({
        label: `Tool result: ${toolNames.get(message.tool_call_id) ?? 'tool'}`,
        kind: 'activity',
        text: apiMessageContentToText(message.content),
        images: message.attachments?.map((attachment) => ({
          name: attachment.alt ?? 'Tool image', dataUrl: attachment.dataUrl ?? '',
        })),
      });
    }
  }
  return entries;
}

export function formatChatTranscript(chat: Chat): string {
  const parts = transcriptEntries(chat).map((entry) => {
    const images = entry.images?.filter((image) => !entry.text.includes(`[image: ${image.name}]`))
      .map((image) => `[image: ${image.name}]`).join('\n');
    return `## ${entry.label}\n\n${entry.text}${images ? `\n\n${images}` : ''}`;
  });
  return [`# ${chat.name || 'Chat transcript'}`, ...parts].join('\n\n');
}

function renderMarkdown(text: string): string {
  // A portable document has no app routing, remote assets, styles from messages, or executable HTML.
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }) as string, {
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  });
}

export function formatChatTranscriptHtml(chat: Chat): string {
  const entries = transcriptEntries(chat);
  const body = entries.map((entry) => {
    const images = (entry.images ?? []).filter((image) =>
      /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(image.dataUrl))
      .map((image) => `<figure><img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name)}"><figcaption>${escapeHtml(image.name)}</figcaption></figure>`).join('');
    if (entry.kind === 'activity') {
      return `<details class="activity"><summary>${escapeHtml(entry.label)}</summary><pre><code>${escapeHtml(entry.text)}</code></pre>${images}</details>`;
    }
    const content = entry.kind === 'user'
      ? `<div class="user-text">${escapeHtml(entry.text)}</div>`
      : renderMarkdown(entry.text);
    return `<section class="message ${entry.kind}" aria-label="${entry.label}"><h2 class="speaker">${entry.label}</h2><div class="prose">${content}${images}</div></section>`;
  }).join('\n');
  const title = escapeHtml(chat.name || 'Chat transcript');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>${title}</title><style>${transcriptExportStyles}</style></head>
<body><main><header><p class="eyebrow">Minnow · Chat transcript</p><h1>${title}</h1><p class="caption">${entries.filter((entry) => entry.kind !== 'activity').length} messages · Tool activity is expandable</p></header>
${body || '<p>No messages yet.</p>'}
<footer>Exported from Minnow. Hidden prompts and private reasoning are omitted.</footer></main></body></html>`;
}

export function chatTranscriptFilename(name: string): string {
  const stem = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 100);
  return `${stem || 'chat'}-transcript.html`;
}
