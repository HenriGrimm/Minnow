/**
 * Reads user-selected files into Attachment records (images, text, PDF, office docs).
 */

import { getLocalServerAvailable } from '../tools/client';
import { randomUUID } from '../lib/random-id.ts';
import { wrapUntrusted } from '../lib/untrusted.mjs';
import { isOfficeExtension, OFFICE_EXTENSIONS } from './document-extensions.mjs';
import type { Attachment } from './types';

export { OFFICE_EXTENSIONS };

/** Hard max file size (matches server read_document limit). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Soft limit: still load text but flag the chip for large files. */
export const LARGE_TEXT_WARN_BYTES = 32 * 1024;

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
]);

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'mdx',
  'json',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'cmd',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sql',
  'graphql',
  'vue',
  'svelte',
  'astro',
  'csv',
  'log',
  'cfg',
  'conf',
  'dockerfile',
  'gitignore',
  'gitattributes',
  'editorconfig',
]);

const OFFICE_MIME_PREFIXES = [
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.ms-',
  'application/vnd.oasis.opendocument.',
  'application/msword',
  'application/rtf',
];

/** Creates a unique attachment id for the pending list. */
function newAttachmentId(): string {
  return randomUUID();
}

/** Lowercase extension without the dot, or empty string. */
function fileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(fileExtension(file.name));
}

function isPdfFile(file: File): boolean {
  if (file.type === 'application/pdf') return true;
  return fileExtension(file.name) === 'pdf';
}

function isOfficeFile(file: File): boolean {
  if (isOfficeExtension(file.name)) return true;
  const mime = file.type.toLowerCase();
  return OFFICE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

/** PDF and office documents share the read_document server tool. */
function isDocumentFile(file: File): boolean {
  return isPdfFile(file) || isOfficeFile(file);
}

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  const ext = fileExtension(file.name);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const lower = file.name.toLowerCase();
  return lower === 'dockerfile' || lower === 'makefile' || lower === 'license';
}

/** Reads a File as a data URL (used for images). */
function readFileAsDataUrl(file: File, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const onAbort = () => reader.abort();
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    reader.onload = () => { cleanup(); resolve(String(reader.result ?? '')); };
    reader.onerror = () => { cleanup(); reject(reader.error ?? new Error('Failed to read file')); };
    reader.onabort = () => { cleanup(); reject(new DOMException('File read canceled', 'AbortError')); };
    if (signal?.aborted) { reject(new DOMException('File read canceled', 'AbortError')); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.readAsDataURL(file);
  });
}

/** Reads a File as UTF-8 text. */
function readFileAsText(file: File, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const onAbort = () => reader.abort();
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    reader.onload = () => { cleanup(); resolve(String(reader.result ?? '')); };
    reader.onerror = () => { cleanup(); reject(reader.error ?? new Error('Failed to read file')); };
    reader.onabort = () => { cleanup(); reject(new DOMException('File read canceled', 'AbortError')); };
    if (signal?.aborted) { reject(new DOMException('File read canceled', 'AbortError')); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.readAsText(file);
  });
}

/** Encodes file bytes as base64 for read_document. */
async function readFileAsBase64(file: File, signal?: AbortSignal): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file, signal);
  const comma = dataUrl.indexOf(',');
  if (comma < 0) {
    throw new Error('Failed to encode file as base64');
  }
  return dataUrl.slice(comma + 1);
}

/** POST read_document to the local tools server (npm start). */
async function extractDocumentText(
  filename: string,
  base64Content: string,
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/tools', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'read_document',
        args: { filename, content: base64Content },
      }),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach Minnow (${message})`);
  }

  let payload: { result?: string; error?: string };
  try {
    payload = (await response.json()) as { result?: string; error?: string };
  } catch {
    throw new Error(`Invalid response from Minnow (HTTP ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(payload.error ?? `Tool server HTTP ${response.status}`);
  }

  const result = String(payload.result ?? '');
  if (result.startsWith('Error:')) {
    throw new Error(result.slice('Error:'.length).trim() || result);
  }
  return result;
}

function errorAttachment(file: File, message: string): Attachment {
  return {
    id: newAttachmentId(),
    name: file.name,
    kind: 'error',
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    error: message,
  };
}

/**
 * Turns one File into an Attachment (image, text, PDF/office text, or error chip).
 */
export async function processFile(file: File, options: { signal?: AbortSignal; id?: string } = {}): Promise<Attachment> {
  const base = {
    id: options.id ?? newAttachmentId(),
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
  };

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return errorAttachment(
      file,
      `File exceeds ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB limit`,
    );
  }

  try {
    if (options.signal?.aborted) throw new DOMException('File read canceled', 'AbortError');
    if (isImageFile(file)) {
      const dataUrl = await readFileAsDataUrl(file, options.signal);
      return { ...base, kind: 'image', dataUrl };
    }

    if (isTextFile(file)) {
      const text = wrapUntrusted(await readFileAsText(file, options.signal), {
        source: `attachment:${file.name}`,
      });
      const largeTextWarning = text.length > LARGE_TEXT_WARN_BYTES;
      return { ...base, kind: 'text', text, largeTextWarning };
    }

    if (isDocumentFile(file)) {
      if (!getLocalServerAvailable()) {
        return errorAttachment(
          file,
          'PDF and office documents require Minnow running locally. Open or restart the app.',
        );
      }
      const content = await readFileAsBase64(file, options.signal);
      const text = await extractDocumentText(file.name, content, options.signal);
      const largeTextWarning = text.length > LARGE_TEXT_WARN_BYTES;
      const kind = isPdfFile(file) ? 'pdf' : 'text';
      return { ...base, kind, text, largeTextWarning };
    }

    return errorAttachment(file, 'Unsupported file type');
  } catch (err) {
    if (options.signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return errorAttachment(file, message);
  }
}
