import { StringDecoder } from 'node:string_decoder';

export const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;

/** Decode arbitrary UTF-8 byte boundaries without treating startup banners as model output. */
export function createJsonlDecoder({ onEvent, onText = () => {}, maxLineBytes = MAX_JSONL_LINE_BYTES }) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let ended = false;
  function line(raw) {
    const text = raw.replace(/^\uFEFF/, '').replace(/\r$/, '');
    if (Buffer.byteLength(text) > maxLineBytes) throw new Error('Agent CLI output record exceeded the size limit.');
    if (!text.trim()) return;
    let value;
    try { value = JSON.parse(text); } catch { onText(text); return; }
    if (value && typeof value === 'object' && !Array.isArray(value)) onEvent(value);
  }
  function drain(text) {
    const parts = text.split('\n');
    if (parts.length === 1) {
      pending += parts[0];
    } else {
      line(pending + parts[0]);
      for (let i = 1; i < parts.length - 1; i += 1) line(parts[i]);
      pending = parts.at(-1);
    }
    if (Buffer.byteLength(pending) > maxLineBytes) throw new Error('Agent CLI output record exceeded the size limit.');
  }
  return {
    write(chunk) {
      if (ended) throw new Error('Agent CLI decoder is already closed.');
      drain(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    },
    end() {
      if (ended) return;
      ended = true;
      drain(decoder.end());
      if (pending) line(pending);
      pending = '';
    },
  };
}
