import { fetchCodeMapFile, findBrainCodeSymbol } from '../../brain/client';
import { kindBadge } from './icons';

/** Choose a graph centre without leaving the call view. */
export async function renderSymbolPicker(
  root: HTMLElement,
  options: {
    file: string | null;
    context: { workspaceRoot?: string };
    isCurrent: () => boolean;
    onPick: (id: string) => void;
  },
): Promise<void> {
  root.replaceChildren();
  root.hidden = false;
  const card = document.createElement('div');
  card.className = 'code-map-empty__card code-map-symbol-picker code-map-no-pan';
  const heading = document.createElement('h2');
  heading.textContent = 'Choose a symbol';
  const description = document.createElement('p');
  description.textContent = options.file
    ? `Choose a symbol in ${options.file}, or search the workspace.`
    : 'Search for a function or method to see what calls it and what it calls.';
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'code-map-symbol-picker__input';
  input.placeholder = 'Search functions and methods…';
  input.setAttribute('aria-label', 'Search symbols for the call graph');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const list = document.createElement('div');
  list.className = 'code-map-symbol-picker__results';
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let defaults: Array<{ id: string; name: string; kind: string; file: string; line: number }> = [];
  const current = () => options.isCurrent() && card.isConnected;
  const draw = (symbols: typeof defaults, message: string) => {
    list.replaceChildren();
    status.textContent = message;
    for (const symbol of symbols) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-map-symbol-picker__result';
      const name = document.createElement('span');
      name.textContent = `${kindBadge(symbol.kind)} · ${symbol.name}`;
      const location = document.createElement('span');
      location.className = 'code-map-symbol-picker__location';
      location.textContent = `${symbol.file}:${symbol.line}`;
      button.append(name, location);
      button.addEventListener('click', () => {
        if (current()) options.onPick(symbol.id);
      });
      list.append(button);
    }
  };
  const search = async () => {
    const token = ++request;
    const query = input.value.trim();
    if (!current()) return;
    if (!query) {
      draw(defaults, options.file && !defaults.length ? 'No symbols indexed in this file. Search another name above.' : '');
      return;
    }
    draw([], 'Searching symbols…');
    const result = await findBrainCodeSymbol(query, 20, options.context);
    if (!current() || token !== request) return;
    const symbols = (result?.matches ?? []).map((s) => ({ ...s, line: s.line_start }));
    draw(symbols, !result ? 'Symbol search unavailable. Check the code index and try again.'
      : result.error ? result.error
      : symbols.length ? '' : 'No matching symbols. Try another name or reindex the workspace.');
  };
  input.addEventListener('input', () => {
    ++request;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void search(); }, 180);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (timer) clearTimeout(timer);
      timer = null;
      void search();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list.querySelector<HTMLButtonElement>('button')?.focus();
    }
  });
  card.append(heading, description, input, status, list);
  root.append(card);
  input.focus();
  if (options.file) {
    status.textContent = 'Loading file symbols…';
    const detail = await fetchCodeMapFile(options.file, options.context);
    if (!current()) return;
    defaults = (detail?.symbols ?? []).map((s) => ({ ...s, file: options.file! }));
    if (!input.value.trim()) draw(defaults, !detail || detail.error
      ? 'File symbols unavailable. Search a symbol name above.'
      : defaults.length ? '' : 'No symbols indexed in this file. Search another name above.');
  }
}
