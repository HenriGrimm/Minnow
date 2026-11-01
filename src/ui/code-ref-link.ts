import { createButton, setButtonClassName } from './components';
import { formatCodeRefLabel } from '../attachments/code-ref-format';
import { iconHtml } from './icon';

export interface CodeRefLinkTarget {
  workspacePath: string;
  /** 1-based start line; omit for a whole-file chip. */
  startLine?: number;
  /** 1-based end line; omit for a whole-file chip. */
  endLine?: number;
}

/** Open the workspace file, optionally selecting a 1-based line range. */
export function openCodeRefInViewer(target: CodeRefLinkTarget): void {
  void import('./file-viewer').then((m) => {
    const startLine = target.startLine;
    const endLine = target.endLine;
    const hasRange =
      startLine != null &&
      endLine != null &&
      Number.isFinite(startLine) &&
      Number.isFinite(endLine);
    void m.openFileInViewer(
      target.workspacePath,
      hasRange
        ? {
            initialLineRange: {
              startLine,
              endLine,
            },
          }
        : undefined,
    );
  });
}

function appendCodeRefParts(
  btn: HTMLButtonElement,
  fileName: string,
  linePart: string,
): void {
  const icon = document.createElement('span');
  icon.className = 'code-ref-link__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '<>';
  btn.appendChild(icon);

  const nameEl = document.createElement('span');
  nameEl.className = 'code-ref-link__name';
  nameEl.textContent = fileName;
  btn.appendChild(nameEl);

  if (linePart) {
    const linesEl = document.createElement('span');
    linesEl.className = 'code-ref-link__lines';
    linesEl.textContent = linePart;
    btn.appendChild(linesEl);
  }
}

/** Build a clickable code-reference control (Cursor-style path + L15-36). */
export function createCodeRefLinkButton(
  target: CodeRefLinkTarget,
  options?: { className?: string },
): HTMLButtonElement {
  const btn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
  btn.type = 'button';
  setButtonClassName(btn, options?.className ?? 'code-ref-link');
  const hasRange =
    target.startLine != null &&
    target.endLine != null &&
    Number.isFinite(target.startLine) &&
    Number.isFinite(target.endLine);

  if (hasRange) {
    const label = formatCodeRefLabel(
      target.workspacePath,
      target.startLine as number,
      target.endLine as number,
    );
    const fileName = label.replace(/\s+L\d+(-\d+)?$/, '');
    const linePart = label.slice(fileName.length).trim();
    btn.title = `Open ${target.workspacePath} ${linePart}`;
    btn.setAttribute('aria-label', `Open ${target.workspacePath} ${linePart}`);
    appendCodeRefParts(btn, fileName, linePart);
  } else {
    const fileName =
      target.workspacePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
      target.workspacePath;
    btn.title = `Open ${target.workspacePath}`;
    btn.setAttribute('aria-label', `Open ${target.workspacePath}`);
    appendCodeRefParts(btn, fileName, '');
  }

  btn.addEventListener('click', () => openCodeRefInViewer(target));
  return btn;
}

/** Build a clickable URL chip in the same class as file chat links. */
export function createUrlLinkButton(
  url: string,
  options?: { className?: string; label?: string },
): HTMLButtonElement {
  const href = url.trim();
  const btn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
  btn.type = 'button';
  setButtonClassName(btn, options?.className ?? 'code-ref-link');
  let label = (options?.label ?? '').trim();
  if (!label) {
    try {
      label = new URL(href).host || href;
    } catch {
      label = href;
    }
  }
  btn.title = `Open ${href}`;
  btn.setAttribute('aria-label', `Open ${href}`);

  const icon = document.createElement('span');
  icon.className = 'code-ref-link__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = iconHtml('globe', { size: 12 });
  btn.appendChild(icon);

  const nameEl = document.createElement('span');
  nameEl.className = 'code-ref-link__name';
  nameEl.textContent = label;
  btn.appendChild(nameEl);

  btn.addEventListener('click', () => {
    void import('./minnow-browser-links').then((m) => {
      m.openUrlInMinnowBrowser(href);
    });
  });
  return btn;
}
