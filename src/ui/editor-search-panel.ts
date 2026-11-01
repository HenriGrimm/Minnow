import { adoptControl } from './components';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search';
import type { ViewUpdate } from '@codemirror/view';
import type { Panel } from '@codemirror/view';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { createIcon, type IconName } from './icon';

/** Build a DOM node with optional attributes and children. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') {
      node.className = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  adoptControl(node, { appearance: 'surface' });
  return node;
}

/** Uicons glyph for compact toolbar buttons. */
function searchIcon(name: IconName, className = 'mn-editor-search__icon'): HTMLElement {
  return createIcon(name, { className });
}

const ICON_PREV: IconName = 'chevronUp';
const ICON_NEXT: IconName = 'chevronDown';
const ICON_CLOSE: IconName = 'close';

function phrase(view: EditorView, text: string): string {
  return view.state.phrase(text);
}

/** Toolbar button wired to a search command. */
function actionButton(
  name: string,
  ariaLabel: string,
  content: (string | Node)[],
  extraClass = '',
): HTMLButtonElement {
  const cls = ['cm-button', 'mn-editor-search__btn', extraClass].filter(Boolean).join(' ');
  return el(
    'button',
    {
      class: cls,
      name,
      type: 'button',
      'aria-label': ariaLabel,
    },
    [el('span', { class: 'mn-editor-search__btn-inner' }, content)],
  ) as HTMLButtonElement;
}

/** Option toggle (case, regexp, whole word) with a short visible label. */
function optionToggle(
  input: HTMLInputElement,
  shortLabel: string,
  title: string,
): HTMLLabelElement {
  return el('label', { class: 'mn-editor-search__toggle', title }, [
    input,
    el('span', { class: 'mn-editor-search__toggle-label' }, [shortLabel]),
  ]);
}

/**
 * Custom search panel: two stacked bars (find + replace), option chips, icon nav.
 */
export class MinnowSearchPanel implements Panel {
  readonly dom: HTMLElement;
  private readonly view: EditorView;
  private query: SearchQuery;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly caseField: HTMLInputElement;
  private readonly reField: HTMLInputElement;
  private readonly wordField: HTMLInputElement;

  constructor(view: EditorView) {
    this.view = view;
    this.query = getSearchQuery(view.state);
    this.commit = this.commit.bind(this);

    this.searchField = el('input', {
      value: this.query.search,
      placeholder: phrase(view, 'Find'),
      'aria-label': phrase(view, 'Find'),
      class: 'cm-textfield mn-editor-search__input',
      name: 'search',
      form: '',
      'main-field': 'true',
    }) as HTMLInputElement;
    this.searchField.addEventListener('change', this.commit);
    this.searchField.addEventListener('keyup', this.commit);

    this.replaceField = el('input', {
      value: this.query.replace,
      placeholder: phrase(view, 'Replace'),
      'aria-label': phrase(view, 'Replace'),
      class: 'cm-textfield mn-editor-search__input',
      name: 'replace',
      form: '',
    }) as HTMLInputElement;
    this.replaceField.addEventListener('change', this.commit);
    this.replaceField.addEventListener('keyup', this.commit);

    this.caseField = el('input', {
      type: 'checkbox',
      name: 'case',
      form: '',
      class: 'mn-editor-search__toggle-input',
    }) as HTMLInputElement;
    this.caseField.checked = this.query.caseSensitive;
    this.caseField.addEventListener('change', this.commit);

    this.reField = el('input', {
      type: 'checkbox',
      name: 're',
      form: '',
      class: 'mn-editor-search__toggle-input',
    }) as HTMLInputElement;
    this.reField.checked = this.query.regexp;
    this.reField.addEventListener('change', this.commit);

    this.wordField = el('input', {
      type: 'checkbox',
      name: 'word',
      form: '',
      class: 'mn-editor-search__toggle-input',
    }) as HTMLInputElement;
    this.wordField.checked = this.query.wholeWord;
    this.wordField.addEventListener('change', this.commit);

    const prevBtn = actionButton('prev', phrase(view, 'previous'), [searchIcon(ICON_PREV)], 'mn-editor-search__btn--icon');
    prevBtn.addEventListener('click', () => findPrevious(view));

    const nextBtn = actionButton('next', phrase(view, 'next'), [searchIcon(ICON_NEXT)], 'mn-editor-search__btn--icon');
    nextBtn.addEventListener('click', () => findNext(view));

    const allBtn = actionButton('select', phrase(view, 'all'), [phrase(view, 'all')], 'mn-editor-search__btn--text');
    allBtn.addEventListener('click', () => selectMatches(view));

    const closeBtn = el(
      'button',
      {
        class: 'cm-button mn-editor-search__btn mn-editor-search__btn--icon mn-editor-search__btn--close',
        name: 'close',
        type: 'button',
        'aria-label': phrase(view, 'close'),
      },
      [searchIcon(ICON_CLOSE)],
    );
    closeBtn.addEventListener('click', () => closeSearchPanel(view));

    const findInputWrapper = el('div', { class: 'mn-editor-search__input-wrapper' }, [
      this.searchField,
      el('div', { class: 'mn-editor-search__toggles' }, [
        optionToggle(this.caseField, 'Aa', phrase(view, 'match case')),
        optionToggle(this.wordField, 'ab', phrase(view, 'by word')),
        optionToggle(this.reField, '.*', phrase(view, 'regexp')),
      ]),
    ]);

    const findBar = el('div', { class: 'mn-editor-search__bar mn-editor-search__bar--find' }, [
      findInputWrapper,
      el('div', { class: 'mn-editor-search__nav' }, [prevBtn, nextBtn, allBtn]),
      closeBtn,
    ]);

    const children: HTMLElement[] = [findBar];

    if (!view.state.readOnly) {
      const replaceBtn = actionButton(
        'replace',
        phrase(view, 'replace'),
        [phrase(view, 'replace')],
        'mn-editor-search__btn--text',
      );
      replaceBtn.addEventListener('click', () => replaceNext(view));

      const replaceAllBtn = actionButton(
        'replaceAll',
        phrase(view, 'replace all'),
        [phrase(view, 'replace all')],
        'mn-editor-search__btn--text',
      );
      replaceAllBtn.addEventListener('click', () => replaceAll(view));

      const replaceInputWrapper = el('div', { class: 'mn-editor-search__input-wrapper' }, [
        this.replaceField,
      ]);

      const replaceBar = el('div', { class: 'mn-editor-search__bar mn-editor-search__bar--replace' }, [
        replaceInputWrapper,
        el('div', { class: 'mn-editor-search__replace-actions' }, [replaceBtn, replaceAllBtn]),
        el('div', { class: 'mn-editor-search__spacer' }),
      ]);
      children.push(replaceBar);
    }

    this.dom = el(
      'div',
      {
        class: 'cm-search mn-editor-search',
      },
      children,
    );
    this.dom.addEventListener('keydown', (e) => this.keydown(e));
  }

  /** Push field values into editor search state. */
  private commit(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.reField.checked,
      wholeWord: this.wordField.checked,
      replace: this.replaceField.value,
    });
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  }

  /** Delegate keys to search keymap; Enter runs find/replace. */
  private keydown(e: KeyboardEvent): void {
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault();
      return;
    }
    if (e.keyCode === 13 && e.target === this.searchField) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
      return;
    }
    if (e.keyCode === 13 && e.target === this.replaceField) {
      e.preventDefault();
      replaceNext(this.view);
    }
  }

  /** Sync inputs when search query changes externally. */
  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.setQuery(effect.value);
        }
      }
    }
  }

  private setQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseField.checked = query.caseSensitive;
    this.reField.checked = query.regexp;
    this.wordField.checked = query.wholeWord;
  }

  mount(): void {
    this.searchField.select();
  }

  get top(): boolean {
    return true;
  }

  get pos(): number {
    return 80;
  }
}

/** Factory for {@link search} `createPanel` config. */
export function createMinnowSearchPanel(view: EditorView): Panel {
  return new MinnowSearchPanel(view);
}
