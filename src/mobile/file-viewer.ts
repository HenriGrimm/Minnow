/**
 * Read-only file viewer for phones: highlighted code with a line gutter,
 * rendered Markdown, images, and a wrap toggle. Editing stays on the desktop.
 */

import { executeTool } from '../tools/client';
import { isImageFilePath } from '../attachments/image-path';
import { getDocumentPreviewKind } from '../attachments/document-path';
import { parseGetFileMetadataSize, readWorkspaceTextFile } from '../attachments/workspace-text-read';
import { resolvePreviewLoadUrl } from '../ui/preview-load-url';
import { recordRecentViewerFile } from '../state/recent-viewer-files';
import { setAssistantBubbleContent } from '../markdown/renderer';
import { highlightCodeElement } from '../markdown/highlighter';
import { screenHeader } from './chrome';
import { el, emptyState, iconButton } from './dom';
import type { MobileScreen } from './nav';
import { openActionSheet } from './sheet';

/** Above this the viewer shows the first lines only, like the desktop viewer. */
const LARGE_FILE_BYTES = 512_000;
const EXCERPT_LINES = 2000;
/** Highlighting very long files freezes a phone; they stay plain. */
const HIGHLIGHT_LIMIT = 200_000;
const WRAP_KEY = 'minnow.mobile.fileWrap';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', lua: 'lua', r: 'r', scala: 'scala', sql: 'sql',
  css: 'css', scss: 'css', less: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', env: 'ini',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'shell', ps1: 'powershell',
  diff: 'diff', patch: 'diff', dockerfile: 'dockerfile',
};

function extensionOf(path: string): string {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : '';
}

function readWrapPreference(): boolean {
  try {
    return window.localStorage.getItem(WRAP_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeWrapPreference(wrap: boolean): void {
  try {
    window.localStorage.setItem(WRAP_KEY, wrap ? '1' : '0');
  } catch {}
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const meta = (await executeTool('get_file_metadata', { path })).content;
    const metaText = typeof meta === 'string' ? meta : '';
    if (metaText.startsWith('Error:')) {
      // Agent file tools can be off; the preview API below still reads the file.
      if (/disabled|not allowed|permission/i.test(metaText)) return null;
      throw new Error(metaText.replace(/^Error:\s*/i, ''));
    }
    return parseGetFileMetadataSize(metaText);
  } catch (error) {
    if (error instanceof Error && !/disabled|not allowed|permission/i.test(error.message)) throw error;
    return null;
  }
}

async function loadText(path: string): Promise<{ text: string; excerpt: boolean; size: number | null }> {
  const size = await fileSize(path);
  if (size !== null && size > LARGE_FILE_BYTES) {
    const range = (await executeTool('read_file_range', { path, start_line: 1, end_line: EXCERPT_LINES })).content;
    const rangeText = typeof range === 'string' ? range : '';
    if (rangeText.startsWith('Error:')) throw new Error(rangeText.replace(/^Error:\s*/i, ''));
    // read_file_range prefixes each line with "N: ".
    const text = rangeText.split('\n').map((line) => line.replace(/^\s*\d+:\s?/, '')).join('\n');
    return { text, excerpt: true, size };
  }
  const text = await readWorkspaceTextFile(path);
  if (size === null && text.length > LARGE_FILE_BYTES) {
    return { text: text.split('\n').slice(0, EXCERPT_LINES).join('\n'), excerpt: true, size: text.length };
  }
  return { text, excerpt: false, size: size ?? text.length };
}

function renderCode(text: string, path: string, wrap: boolean): HTMLElement {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const gutter = el('pre', { className: 'm-code__gutter', attrs: { 'aria-hidden': 'true' } });
  gutter.textContent = lines.map((_, index) => index + 1).join('\n');
  const code = el('code');
  const language = LANGUAGE_BY_EXTENSION[extensionOf(path)];
  if (language) code.className = `language-${language}`;
  code.textContent = lines.join('\n');
  if (language && text.length <= HIGHLIGHT_LIMIT) void highlightCodeElement(code);
  const bodyPre = el('pre', { className: 'm-code__body' }, code);
  return el('div', { className: `m-code${wrap ? ' is-wrapped' : ''}` }, gutter, bodyPre);
}

export function createFileViewerScreen(path: string, deps: { openDir(path: string): void }): MobileScreen {
  const name = path.split('/').pop() || path;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  let wrap = readWrapPreference();
  let markdownSource = false;
  let loadedText: string | null = null;

  const wrapBtn = iconButton('fi-rr-text', 'Wrap lines', () => {
    wrap = !wrap;
    writeWrapPreference(wrap);
    syncWrap();
  });
  const header = screenHeader({
    title: name,
    subtitle: dir || 'Workspace root',
    back: true,
    actions: [wrapBtn, iconButton('fi-rr-menu-dots-vertical', 'File actions', () => openMenu())],
  });
  const body = el('div', { className: 'm-screen__body m-file-viewer' });
  const root = el('section', { className: 'm-screen', dataset: { screen: `file:${path}` } }, header.el, body);
  const isMarkdown = ['md', 'markdown', 'mdx'].includes(extensionOf(path));

  function syncWrap(): void {
    wrapBtn.setAttribute('aria-pressed', String(wrap));
    wrapBtn.classList.toggle('is-active', wrap);
    body.querySelector('.m-code')?.classList.toggle('is-wrapped', wrap);
  }

  function rawUrl(): string {
    return resolvePreviewLoadUrl({ kind: 'workspace', path }, undefined, undefined, { raw: true });
  }

  function paintText(): void {
    if (loadedText == null) return;
    if (isMarkdown && !markdownSource) {
      const md = el('div', { className: 'm-md m-md--document' });
      setAssistantBubbleContent(md, loadedText);
      body.replaceChildren(md);
      wrapBtn.hidden = true;
      return;
    }
    wrapBtn.hidden = false;
    body.replaceChildren(renderCode(loadedText, path, wrap));
    syncWrap();
  }

  async function load(): Promise<void> {
    body.replaceChildren(el('div', { className: 'm-skeleton' }), el('div', { className: 'm-skeleton' }), el('div', { className: 'm-skeleton' }));
    if (isImageFilePath(path)) {
      wrapBtn.hidden = true;
      const img = el('img', { className: 'm-image', attrs: { alt: name, src: resolvePreviewLoadUrl({ kind: 'workspace', path }), decoding: 'async' } });
      img.addEventListener('error', () => body.replaceChildren(emptyState({ glyph: 'fi-rr-picture', title: 'Could not load this image' })));
      body.replaceChildren(el('div', { className: 'm-image-frame' }, img));
      return;
    }
    if (getDocumentPreviewKind(path)) {
      wrapBtn.hidden = true;
      body.replaceChildren(
        emptyState({
          glyph: 'fi-rr-document',
          title: 'Open to view',
          body: 'This document opens in your browser.',
          action: { label: 'Open', onClick: () => window.open(rawUrl(), '_blank', 'noopener') },
        }),
      );
      return;
    }
    try {
      const { text, excerpt, size } = await loadText(path);
      if (text.includes('\u0000')) {
        wrapBtn.hidden = true;
        body.replaceChildren(
          emptyState({
            glyph: 'fi-rr-file',
            title: 'Binary file',
            body: size != null ? formatBytes(size) : undefined,
            action: { label: 'Open in browser', onClick: () => window.open(rawUrl(), '_blank', 'noopener') },
          }),
        );
        return;
      }
      loadedText = text;
      header.setSubtitle([dir || 'Workspace root', size != null ? formatBytes(size) : ''].filter(Boolean).join(' · '));
      paintText();
      if (excerpt) {
        body.prepend(el('p', { className: 'm-note', text: `Large file: showing the first ${EXCERPT_LINES} lines.` }));
      }
      recordRecentViewerFile(path);
    } catch (error) {
      body.replaceChildren(
        emptyState({
          glyph: 'fi-rr-cloud-disabled',
          title: 'Could not open this file',
          body: error instanceof Error ? error.message : String(error),
          action: { label: 'Try again', onClick: () => void load() },
        }),
      );
    }
  }

  function openMenu(): void {
    openActionSheet(name, [
      ...(isMarkdown && loadedText != null
        ? [{
            label: markdownSource ? 'Show formatted' : 'Show source',
            glyph: markdownSource ? 'fi-rr-eye' : 'fi-rr-code-simple',
            run: () => {
              markdownSource = !markdownSource;
              paintText();
            },
          }]
        : []),
      {
        label: 'Copy path',
        glyph: 'fi-rr-copy',
        run: async () => {
          const { showToast } = await import('../ui/toast');
          try {
            await navigator.clipboard.writeText(path);
            showToast('Path copied');
          } catch {
            showToast('Clipboard is not available here', 'error');
          }
        },
      },
      ...(loadedText != null
        ? [{
            label: 'Copy contents',
            glyph: 'fi-rr-duplicate',
            run: async () => {
              const { showToast } = await import('../ui/toast');
              try {
                await navigator.clipboard.writeText(loadedText ?? '');
                showToast('Copied');
              } catch {
                showToast('Clipboard is not available here', 'error');
              }
            },
          }]
        : []),
      { label: 'Open folder', glyph: 'fi-rr-folder', run: () => deps.openDir(dir || '.') },
      { label: 'Open raw', glyph: 'fi-rr-arrow-up-right-from-square', run: () => void window.open(rawUrl(), '_blank', 'noopener') },
    ]);
  }

  let loaded = false;
  return {
    key: `file:${path}`,
    el: root,
    onShow() {
      if (loaded) return;
      loaded = true;
      void load();
    },
  };
}
