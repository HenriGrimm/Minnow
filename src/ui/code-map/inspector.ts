/**
 * Code map inspector: the floating panel describing the selected module, package, folder,
 * file or symbol — what it does, what it links to, and what to do next.
 */

import type {
  BrainCodeExplainPage,
  BrainCodeSymbolMatch,
  CodeMapFileDetail,
  CodeMapFolder,
  CodeMapPathCount,
} from '../../brain/types';
import { kindBadge, languageTag, renderIcon, type CodeMapIcon } from './icons';

export interface InspectorActions {
  /** Files view of a folder. */
  drillInto(path: string): void;
  /** Select another node on the current map. */
  selectNode(id: string): void;
  /** Files view of the file's folder with the file selected. */
  showFile(path: string): void;
  /** Calls view centred on a symbol. */
  showSymbol(symbolId: string): void;
  openInEditor(path: string, line?: number, endLine?: number): void;
  expandLayer(groupId: string): void;
  ask(subject: string, question: string): void;
  copy(text: string, what: string): void;
  openWikiPage(path: string): void;
  close(): void;
  /** Whether the Ask box can reach a chat composer here. */
  canAsk: boolean;
}

export interface LinkRow {
  id: string;
  label: string;
  n: number;
  /** Unit for the count ("calls", "files"). */
  unit: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function glyph(cls: string): HTMLElement {
  const i = el('i', `fi ${cls}`);
  i.setAttribute('aria-hidden', 'true');
  return i;
}

function count(n: number, unit: string): string {
  return `${n.toLocaleString()} ${unit}${n === 1 ? '' : 's'}`;
}

/** Panel skeleton: header, scrolling body, optional footer. Returns the body. */
function frame(
  root: HTMLElement,
  head: { icon: CodeMapIcon; title: string; meta: string[]; accent?: string; mono?: boolean },
  actions: InspectorActions,
): { body: HTMLElement; footer: HTMLElement } {
  root.replaceChildren();
  root.hidden = false;
  const header = el('div', 'code-map-insp__head');
  const tile = el('span', 'code-map-insp__icon');
  tile.append(renderIcon(head.icon));
  const titles = el('div', 'code-map-insp__titles');
  const title = el('h2', `code-map-insp__title${head.mono ? ' is-mono' : ''}`, head.title);
  title.title = head.title;
  const meta = el('p', 'code-map-insp__meta');
  head.meta.filter(Boolean).forEach((part, i) => {
    if (i) meta.append(el('span', 'code-map-insp__dot', '·'));
    meta.append(el('span', i === 0 && head.mono !== false ? 'is-mono' : '', part));
  });
  if (head.accent) {
    meta.append(el('span', 'code-map-insp__dot', '·'));
    meta.append(el('span', 'code-map-insp__accent', head.accent));
  }
  titles.append(title, meta);
  const close = el('button', 'code-map-icon-btn');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close inspector');
  close.append(glyph('fi-rr-cross-small'));
  close.addEventListener('click', () => actions.close());
  header.append(tile, titles, close);
  const body = el('div', 'code-map-insp__body');
  const footer = el('div', 'code-map-insp__foot');
  root.append(header, body, footer);
  return { body, footer };
}

function section(body: HTMLElement, heading: string, aside?: string): HTMLElement {
  const sec = el('section', 'code-map-insp__section');
  const head = el('div', 'code-map-insp__section-head');
  head.append(el('h3', 'code-map-insp__h', heading));
  if (aside) head.append(el('span', 'code-map-insp__aside', aside));
  sec.append(head);
  body.append(sec);
  return sec;
}

function loading(sec: HTMLElement, text = 'Loading…'): HTMLElement {
  const p = el('p', 'code-map-insp__muted', text);
  sec.append(p);
  return p;
}

function prose(sec: HTMLElement, text: string): void {
  sec.append(el('p', 'code-map-insp__prose', text));
}

function row(
  parent: HTMLElement,
  opts: { icon?: string; label: string; trailing?: string; mono?: boolean; onClick?: () => void; title?: string },
): HTMLElement {
  const item = opts.onClick ? el('button', 'code-map-insp__row') : el('div', 'code-map-insp__row is-static');
  if (item instanceof HTMLButtonElement) {
    item.type = 'button';
    item.addEventListener('click', () => opts.onClick?.());
  }
  if (opts.icon) item.append(glyph(opts.icon));
  const label = el('span', `code-map-insp__row-label${opts.mono ? ' is-mono' : ''}`, opts.label);
  label.title = opts.title ?? opts.label;
  item.append(label);
  if (opts.trailing) item.append(el('span', 'code-map-insp__row-trail', opts.trailing));
  parent.append(item);
  return item;
}

/** "Depends on" / "Used by" rows with a "show all" toggle past the first five. */
function linkRows(sec: HTMLElement, rows: LinkRow[], icon: string, onPick: (id: string) => void, empty: string): void {
  if (!rows.length) {
    sec.append(el('p', 'code-map-insp__muted', empty));
    return;
  }
  const list = el('div', 'code-map-insp__rows');
  const render = (all: boolean) => {
    list.replaceChildren();
    for (const r of all ? rows : rows.slice(0, 5)) {
      row(list, { icon, label: r.label, trailing: count(r.n, r.unit), onClick: () => onPick(r.id) });
    }
    if (!all && rows.length > 5) {
      const more = el('button', 'code-map-insp__more', `Show all ${rows.length}`);
      more.type = 'button';
      more.addEventListener('click', () => render(true));
      list.append(more);
    }
  };
  render(false);
  sec.append(list);
}

function askBox(footer: HTMLElement, subject: string, actions: InspectorActions): void {
  if (!actions.canAsk) return;
  const form = el('form', 'code-map-ask code-map-ask-only');
  const input = el('input', 'code-map-ask__input');
  input.type = 'text';
  input.placeholder = `Ask about ${subject}…`;
  input.setAttribute('aria-label', `Ask about ${subject}`);
  const send = el('button', 'code-map-icon-btn code-map-ask__send');
  send.type = 'submit';
  send.setAttribute('aria-label', 'Ask in chat');
  send.append(glyph('fi-rr-arrow-up'));
  form.append(input, send);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    if (q) actions.ask(subject, q);
  });
  footer.append(form);
}

/** "Ask for a summary" — only where the Ask box can reach a composer. */
function summaryAsk(sec: HTMLElement, subject: string, question: string, actions: InspectorActions): void {
  if (!actions.canAsk) return;
  const btn = el('button', 'code-map-link-btn code-map-ask-only');
  btn.type = 'button';
  btn.append(glyph('fi-rr-magic-wand'), document.createTextNode(' Ask for a summary'));
  btn.addEventListener('click', () => actions.ask(subject, question));
  sec.append(btn);
}

function buttons(footer: HTMLElement, items: Array<{ label: string; icon?: string; primary?: boolean; onClick: () => void }>): void {
  const bar = el('div', 'code-map-insp__actions');
  for (const item of items) {
    const btn = el('button', `code-map-btn${item.primary ? ' is-primary' : ''}`);
    btn.type = 'button';
    if (item.icon) btn.append(glyph(item.icon));
    btn.append(el('span', '', item.label));
    btn.addEventListener('click', item.onClick);
    bar.append(btn);
  }
  footer.prepend(bar);
}

function fileRow(parent: HTMLElement, p: CodeMapPathCount, unit: string, actions: InspectorActions): void {
  const name = p.path.split('/').pop() || p.path;
  row(parent, {
    label: name,
    trailing: count(p.n, unit),
    mono: true,
    title: p.path,
    onClick: () => actions.showFile(p.path),
  }).prepend(el('span', 'code-map-insp__lang', languageTag(name) || 'F'));
}

// ── Module / folder ──────────────────────────────────────────────────────────

export interface FolderInspectorInput {
  icon: CodeMapIcon;
  title: string;
  path: string;
  meta: string[];
  layerLabel?: string;
  dependsOn: LinkRow[];
  usedBy: LinkRow[];
  packages?: LinkRow[];
  folder: Promise<CodeMapFolder | null>;
  isCurrent(): boolean;
}

/** Module (architecture) or subfolder (files view). */
export async function renderFolderInspector(root: HTMLElement, input: FolderInspectorInput, actions: InspectorActions): Promise<void> {
  const { body, footer } = frame(
    root,
    { icon: input.icon, title: input.title, meta: input.meta, accent: input.layerLabel, mono: false },
    actions,
  );
  const about = section(body, 'What it does');
  const aboutLoading = loading(about);

  const deps = section(body, 'Depends on');
  linkRows(deps, input.dependsOn, 'fi-rr-arrow-right', actions.selectNode, 'No calls out to other modules.');
  const users = section(body, 'Used by');
  linkRows(users, input.usedBy, 'fi-rr-arrow-left', actions.selectNode, 'Nothing else on the map calls into it.');
  if (input.packages?.length) {
    const pk = section(body, 'Packages it imports');
    linkRows(pk, input.packages, 'fi-rr-box-open', actions.selectNode, '');
  }
  const keyFiles = section(body, 'Key files', 'most called');
  const filesLoading = loading(keyFiles);

  buttons(footer, [
    { label: 'Drill in', icon: 'fi-rr-sitemap', primary: true, onClick: () => actions.drillInto(input.path) },
    { label: 'Copy path', onClick: () => actions.copy(input.path || '.', 'Path') },
  ]);
  askBox(footer, input.title, actions);

  const folder = await input.folder;
  if (!input.isCurrent()) return;
  aboutLoading.remove();
  if (folder?.summary?.text) {
    prose(about, folder.summary.text);
    about.append(el('p', 'code-map-insp__source', `From ${folder.summary.source}`));
  } else {
    about.append(el('p', 'code-map-insp__muted', 'No README or header comment here yet.'));
    summaryAsk(about, input.title, `Summarize what \`${input.path || '.'}\` does: its job, its key files, and who uses it.`, actions);
  }
  filesLoading.remove();
  const files = (folder?.nodes ?? [])
    .filter((n) => n.kind === 'file' && n.callsIn > 0)
    .sort((a, b) => b.callsIn - a.callsIn)
    .slice(0, 6);
  if (!files.length) {
    keyFiles.append(el('p', 'code-map-insp__muted', 'No calls into files directly in this folder.'));
  } else {
    const list = el('div', 'code-map-insp__rows');
    for (const f of files) fileRow(list, { path: f.path, n: f.callsIn }, 'call', actions);
    keyFiles.append(list);
  }
}

// ── Folded layer / package ───────────────────────────────────────────────────

export function renderMoreInspector(
  root: HTMLElement,
  input: { groupId: string; layerLabel: string; modules: Array<{ id: string; name: string; path: string; files: number }> },
  actions: InspectorActions,
): void {
  const { body, footer } = frame(
    root,
    { icon: { kind: 'glyph', cls: 'fi-rr-apps' }, title: `${input.modules.length} more in ${input.layerLabel}`, meta: ['Smaller modules, folded'], mono: false },
    actions,
  );
  const sec = section(body, 'Modules');
  const list = el('div', 'code-map-insp__rows');
  for (const mod of input.modules) {
    row(list, { icon: 'fi-rr-folder', label: mod.name, trailing: count(mod.files, 'file'), title: mod.path, onClick: () => actions.drillInto(mod.path) });
  }
  sec.append(list);
  buttons(footer, [{ label: 'Show all on the map', icon: 'fi-rr-expand', primary: true, onClick: () => actions.expandLayer(input.groupId) }]);
}

export function renderPackageInspector(
  root: HTMLElement,
  input: { icon: CodeMapIcon; name: string; files: number; testFiles: number; usedBy: LinkRow[] },
  actions: InspectorActions,
): void {
  const { body, footer } = frame(
    root,
    { icon: input.icon, title: input.name, meta: ['External package', count(input.files, 'file')], mono: false },
    actions,
  );
  const about = section(body, 'Where it is used');
  prose(
    about,
    `Imported in ${count(input.files, 'file')} across ${count(input.usedBy.length, 'module')}${
      input.testFiles ? `, plus ${count(input.testFiles, 'test file')}` : ''
    }.`,
  );
  const users = section(body, 'Imported by');
  linkRows(users, input.usedBy, 'fi-rr-arrow-left', actions.selectNode, 'Not imported by anything on the map.');
  buttons(footer, [{ label: 'Copy name', onClick: () => actions.copy(input.name, 'Package name') }]);
  askBox(footer, input.name, actions);
}

// ── File ─────────────────────────────────────────────────────────────────────

export async function renderFileInspector(
  root: HTMLElement,
  input: { path: string; detail: Promise<CodeMapFileDetail | null>; isCurrent(): boolean },
  actions: InspectorActions,
): Promise<void> {
  const name = input.path.split('/').pop() || input.path;
  const dir = input.path.includes('/') ? input.path.slice(0, input.path.lastIndexOf('/')) : '.';
  const { body, footer } = frame(
    root,
    { icon: { kind: 'mono', text: languageTag(name) || 'F' }, title: name, meta: [dir], mono: true },
    actions,
  );
  const about = section(body, 'What it does');
  const aboutLoading = loading(about);
  buttons(footer, [
    { label: 'Open in editor', icon: 'fi-rr-code-simple', primary: true, onClick: () => actions.openInEditor(input.path) },
    { label: 'Copy path', onClick: () => actions.copy(input.path, 'Path') },
  ]);
  askBox(footer, name, actions);

  const detail = await input.detail;
  if (!input.isCurrent()) return;
  aboutLoading.remove();
  if (!detail || detail.error) {
    about.append(el('p', 'code-map-insp__muted', 'This file is not in the code index.'));
    return;
  }
  const meta = root.querySelector('.code-map-insp__meta');
  meta?.append(el('span', 'code-map-insp__dot', '·'), el('span', '', count(detail.lines, 'line')));
  if (detail.summary) prose(about, detail.summary);
  else {
    about.append(el('p', 'code-map-insp__muted', 'No header comment in this file.'));
    summaryAsk(about, name, `Summarize what \`${input.path}\` does and how the rest of the code uses it.`, actions);
  }

  const top = detail.symbols.filter((s) => s.depth === 0);
  const syms = section(body, `Symbols · ${top.length}`, 'click for its call graph');
  if (!top.length) {
    syms.append(el('p', 'code-map-insp__muted', 'No symbols indexed in this file.'));
  } else {
    const chips = el('div', 'code-map-insp__chips');
    for (const sym of top.slice(0, 40)) {
      const chip = el('button', 'code-map-chip');
      chip.type = 'button';
      chip.append(el('span', 'code-map-chip__kind', kindBadge(sym.kind)), el('span', 'code-map-chip__name', sym.name));
      chip.title = sym.signature || sym.name;
      chip.addEventListener('click', () => actions.showSymbol(sym.id));
      chips.append(chip);
    }
    syms.append(chips);
    if (top.length > 40) syms.append(el('p', 'code-map-insp__muted', `${top.length - 40} more — open the file to see them.`));
  }

  const callers = section(body, `Called from · ${detail.callerCount}`);
  if (!detail.callers.length) callers.append(el('p', 'code-map-insp__muted', 'No indexed calls from other files.'));
  else {
    const list = el('div', 'code-map-insp__rows');
    for (const c of detail.callers.slice(0, 8)) fileRow(list, c, 'call', actions);
    callers.append(list);
  }
  const callees = section(body, `Calls into · ${detail.calleeCount}`);
  if (!detail.callees.length) callees.append(el('p', 'code-map-insp__muted', 'No indexed calls into other files.'));
  else {
    const list = el('div', 'code-map-insp__rows');
    for (const c of detail.callees.slice(0, 8)) fileRow(list, c, 'call', actions);
    callees.append(list);
  }
}

// ── Symbol ───────────────────────────────────────────────────────────────────

/** Strip the `123: ` prefixes read-symbol adds to each line. */
export function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\d+: ?/, ''))
    .join('\n');
}

function languageClass(file: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby',
    php: 'php', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', lua: 'lua',
    css: 'css', html: 'xml', sql: 'sql', sh: 'bash',
  };
  return map[ext] ? `language-${map[ext]}` : '';
}

export async function renderSymbolInspector(
  root: HTMLElement,
  input: {
    symbol: BrainCodeSymbolMatch;
    source: Promise<string>;
    pages: Promise<BrainCodeExplainPage[] | null>;
    isCurrent(): boolean;
  },
  actions: InspectorActions,
): Promise<void> {
  const sym = input.symbol;
  const where = `${sym.file}:${sym.line_start}`;
  const { body, footer } = frame(
    root,
    { icon: { kind: 'mono', text: kindBadge(sym.kind) }, title: sym.name, meta: [sym.kind, where], mono: true },
    actions,
  );
  const about = section(body, 'What it does');
  if (sym.doc?.trim()) prose(about, sym.doc.trim());
  else if (sym.signature?.includes('(')) about.append(el('p', 'code-map-insp__sig', sym.signature));
  if (!sym.doc?.trim()) about.append(el('p', 'code-map-insp__muted', 'No doc comment on this symbol.'));

  const src = section(body, 'Source');
  const open = el('button', 'code-map-link-btn', `Open at line ${sym.line_start}`);
  open.type = 'button';
  open.addEventListener('click', () => actions.openInEditor(sym.file, sym.line_start, sym.line_end));
  src.querySelector('.code-map-insp__section-head')?.append(open);
  const srcLoading = loading(src);

  const wiki = section(body, 'Wiki pages');
  const wikiLoading = loading(wiki);

  buttons(footer, [
    { label: 'Open in editor', icon: 'fi-rr-code-simple', primary: true, onClick: () => actions.openInEditor(sym.file, sym.line_start, sym.line_end) },
    { label: 'Copy reference', onClick: () => actions.copy(where, 'Reference') },
  ]);
  askBox(footer, sym.name, actions);

  const [source, pages] = await Promise.all([input.source, input.pages]);
  if (!input.isCurrent()) return;
  srcLoading.remove();
  if (source) {
    const pre = el('pre', 'code-map-code');
    const code = el('code', languageClass(sym.file));
    const lines = stripLineNumbers(source).split('\n');
    code.textContent = lines.slice(0, 80).join('\n') + (lines.length > 80 ? '\n…' : '');
    pre.append(code);
    src.append(pre);
    void import('../../markdown/highlighter').then((m) => m.highlightCodeElement(code)).catch(() => {});
  } else {
    src.append(el('p', 'code-map-insp__muted', 'Source not available. The file may have moved since the last index.'));
  }

  wikiLoading.remove();
  if (pages?.length) {
    const list = el('div', 'code-map-insp__rows');
    for (const page of pages) {
      row(list, {
        icon: 'fi-rr-book-alt',
        label: page.title,
        trailing: page.status === 'stale' ? 'stale' : undefined,
        onClick: () => actions.openWikiPage(page.path),
      });
    }
    wiki.append(list);
  } else {
    const empty = el('div', 'code-map-insp__empty');
    empty.append(el('p', 'code-map-insp__muted', 'No Brain pages are anchored to this symbol yet.'));
    if (actions.canAsk) {
      const explain = el('button', 'code-map-btn code-map-ask-only', 'Explain');
      explain.type = 'button';
      explain.addEventListener('click', () =>
        actions.ask(sym.name, `Explain what \`${sym.name}\` in ${where} does and how it is used.`),
      );
      empty.append(explain);
    }
    wiki.append(empty);
  }
}

/** Placeholder shown before anything is selected. */
export function renderIdleInspector(root: HTMLElement): void {
  root.replaceChildren();
  root.hidden = true;
}
