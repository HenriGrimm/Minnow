import { chatReferencesInText, decorateChatReference } from './chat-reference-chip';
import { appendHighlightedSkillText } from '../skills/skill-chip';

interface InlineComposer {
  editor: HTMLDivElement;
  value: string;
  publishing: boolean;
}
const composers = new WeakMap<HTMLTextAreaElement, InlineComposer>();
const inputsByEditor = new WeakMap<Element, HTMLTextAreaElement>();
const selectionDocuments = new WeakSet<Document>();
const sourceAttribute = 'data-chat-reference';

/** Serialize chips back into their original references, including contenteditable line breaks. */
export function inlineComposerText(root: Node): string {
  if (root.nodeType === 3) return root.textContent ?? '';
  if (root.nodeType === 1 && (root as Element).hasAttribute(sourceAttribute)) return (root as Element).getAttribute(sourceAttribute)!;
  if (root.nodeName === 'BR') return '\n';
  const children = [...root.childNodes];
  if (children.length === 1 && children[0]!.nodeName === 'BR') return '';
  let text = '';
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    const block = ['DIV', 'P'].includes(child.nodeName);
    const previousBlock = index > 0 && ['DIV', 'P'].includes(children[index - 1]!.nodeName);
    if (index > 0 && (block || previousBlock) && !text.endsWith('\n')) text += '\n';
    text += inlineComposerText(child);
  }
  return text;
}

function selectionOffsets(editor: HTMLElement): [number, number] | null {
  const selection = editor.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = inlineComposerText(prefix.cloneContents()).length;
  prefix.setEnd(range.endContainer, range.endOffset);
  return [start, inlineComposerText(prefix.cloneContents()).length];
}

function restoreSelection(editor: HTMLElement, start: number, end: number): void {
  const point = (offset: number): [Node, number] => {
    for (const node of editor.childNodes) {
      const size = inlineComposerText(node).length;
      if (offset <= size) {
        if (node.nodeType === 3) return [node, offset];
        const index = [...editor.childNodes].indexOf(node);
        return [editor, index + (offset > 0 ? 1 : 0)];
      }
      offset -= size;
    }
    return [editor, editor.childNodes.length];
  };
  const range = editor.ownerDocument.createRange();
  range.setStart(...point(start));
  range.setEnd(...point(end));
  const selection = editor.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function render(editor: HTMLElement, value: string): void {
  editor.replaceChildren();
  let end = 0;
  for (const reference of chatReferencesInText(value)) {
    appendHighlightedSkillText(editor, value.slice(end, reference.start));
    const anchor = document.createElement('a');
    decorateChatReference(anchor, reference.chatId);
    const chip = document.createElement('span');
    chip.className = 'chat-reference-chip composer-inline-chat-reference';
    chip.contentEditable = 'false';
    chip.setAttribute(sourceAttribute, value.slice(reference.start, reference.end));
    chip.setAttribute('aria-label', `Chat: ${anchor.textContent}`);
    chip.title = `Chat: ${anchor.textContent}`;
    chip.append(...anchor.childNodes);
    editor.append(chip);
    end = reference.end;
  }
  appendHighlightedSkillText(editor, value.slice(end));
}

function publish(input: HTMLTextAreaElement, state: InlineComposer): void {
  state.value = inlineComposerText(state.editor);
  input.value = state.value;
  const offsets = selectionOffsets(state.editor);
  if (offsets) input.setSelectionRange(...offsets);
  state.publishing = true;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  state.publishing = false;
  syncInlineComposerReferences(input);
}

function insertPlainText(input: HTMLTextAreaElement, state: InlineComposer, text: string): void {
  const editor = state.editor;
  const offsets = selectionOffsets(editor) ?? [input.selectionStart, input.selectionEnd];
  const next = state.value.slice(0, offsets[0]) + text + state.value.slice(offsets[1]);
  const insertion = document.createElement('div');
  render(insertion, text);
  if (typeof document.execCommand === 'function' && document.activeElement === editor) {
    document.execCommand('insertHTML', false, insertion.innerHTML.replace(/\n/g, '<br>'));
    if (state.value !== inlineComposerText(editor)) publish(input, state);
    restoreSelection(editor, offsets[0] + text.length, offsets[0] + text.length);
  } else {
    input.value = next;
    state.value = next;
    render(editor, next);
    restoreSelection(editor, offsets[0] + text.length, offsets[0] + text.length);
    publish(input, state);
  }
}

function createComposer(input: HTMLTextAreaElement): InlineComposer {
  const metrics = input.ownerDocument.defaultView?.getComputedStyle(input);
  let host = input.parentElement!;
  if (!host.classList.contains('composer-skill-highlight-host')) {
    host = document.createElement('div');
    host.className = 'composer-skill-highlight-host';
    input.before(host);
    host.append(input);
  }
  const editor = document.createElement('div');
  editor.className = 'composer-inline-editor';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', input.getAttribute('aria-label') || document.querySelector(`label[for="${input.id}"]`)?.textContent || 'Message');
  editor.dataset.composerInputId = input.id;
  editor.spellcheck = input.spellcheck;
  if (metrics) {
    for (const property of ['font-family', 'font-size', 'line-height', 'letter-spacing', 'padding', 'min-height', 'max-height']) {
      editor.style.setProperty(property, metrics.getPropertyValue(property));
    }
  }
  host.append(editor);
  const state: InlineComposer = { editor, value: input.value, publishing: false };
  composers.set(input, state);
  inputsByEditor.set(editor, input);
  if (!selectionDocuments.has(input.ownerDocument)) {
    selectionDocuments.add(input.ownerDocument);
    input.ownerDocument.addEventListener('selectionchange', () => {
      const active = input.ownerDocument.activeElement;
      const source = active ? inputsByEditor.get(active) : undefined;
      if (!active || !source) return;
      const offsets = selectionOffsets(active as HTMLElement);
      if (offsets && (source.selectionStart !== offsets[0] || source.selectionEnd !== offsets[1])) source.setSelectionRange(...offsets);
    });
  }
  input.classList.add('composer-inline-source');
  input.setAttribute('aria-hidden', 'true');
  const syncAttributes = (): void => {
    editor.contentEditable = String(!input.disabled && !input.readOnly);
    editor.setAttribute('aria-disabled', String(input.disabled));
    editor.setAttribute('aria-readonly', String(input.readOnly));
    editor.dataset.placeholder = input.placeholder;
    for (const attribute of ['aria-controls', 'aria-expanded', 'aria-autocomplete', 'aria-activedescendant']) {
      const value = input.getAttribute(attribute);
      if (value === null) editor.removeAttribute(attribute);
      else editor.setAttribute(attribute, value);
    }
  };
  syncAttributes();
  new input.ownerDocument.defaultView!.MutationObserver(syncAttributes).observe(input, {
    attributes: true, attributeFilter: ['disabled', 'readonly', 'placeholder', 'aria-controls', 'aria-expanded', 'aria-autocomplete', 'aria-activedescendant'],
  });
  const focus = input.focus.bind(input);
  input.focus = options => {
    if (!input.classList.contains('composer-inline-source')) { focus(options); return; }
    syncInlineComposerReferences(input);
    editor.focus(options);
    restoreSelection(editor, input.selectionStart, input.selectionEnd);
  };
  editor.addEventListener('input', event => {
    event.stopPropagation();
    publish(input, state);
  });
  for (const type of ['focus', 'blur'] as const) {
    editor.addEventListener(type, () => input.dispatchEvent(new input.ownerDocument.defaultView!.FocusEvent(type)));
  }
  for (const type of ['keydown', 'keyup'] as const) {
    editor.addEventListener(type, event => {
      const offsets = selectionOffsets(editor);
      if (offsets) input.setSelectionRange(...offsets);
      const forwarded = new input.ownerDocument.defaultView!.KeyboardEvent(type, {
        key: event.key, code: event.code, keyCode: event.keyCode,
        shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey,
        isComposing: event.isComposing, repeat: event.repeat, bubbles: true, cancelable: true,
      });
      input.dispatchEvent(forwarded);
      if (forwarded.defaultPrevented) event.preventDefault();
      event.stopPropagation();
      syncInlineComposerReferences(input);
    });
  }
  editor.addEventListener('paste', event => {
    if (input.disabled || input.readOnly || !event.clipboardData) return;
    const text = event.clipboardData.getData('text/plain');
    if (!text) {
      const forwarded = new ClipboardEvent('paste', { clipboardData: event.clipboardData, bubbles: true, cancelable: true });
      input.dispatchEvent(forwarded);
      if (forwarded.defaultPrevented) event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    insertPlainText(input, state, text);
  });
  for (const type of ['copy', 'cut'] as const) {
    editor.addEventListener(type, event => {
      const offsets = selectionOffsets(editor);
      if (!offsets || !event.clipboardData) return;
      event.clipboardData.setData('text/plain', state.value.slice(...offsets));
      event.preventDefault();
      if (type === 'cut' && !input.disabled && !input.readOnly) insertPlainText(input, state, '');
    });
  }
  return state;
}

/** Keep the textarea as the send/draft source, with an editable inline chip presentation. */
export function syncInlineComposerReferences(input: HTMLTextAreaElement): boolean {
  let state = composers.get(input);
  if (!state && (!input.parentElement || !chatReferencesInText(input.value).length)) return false;
  const hadFocus = document.activeElement === input;
  if (!state) {
    state = createComposer(input);
    render(state.editor, input.value);
  }
  if (!state.publishing && state.value !== input.value) {
    state.value = input.value;
    render(state.editor, input.value);
    if (document.activeElement === state.editor) restoreSelection(state.editor, input.selectionStart, input.selectionEnd);
  }
  if (!state.publishing && chatReferencesInText(input.value).length > state.editor.querySelectorAll(`[${sourceAttribute}]`).length) {
    const offsets = selectionOffsets(state.editor);
    render(state.editor, input.value);
    if (offsets) restoreSelection(state.editor, ...offsets);
  }
  if (hadFocus) {
    state.editor.focus();
    restoreSelection(state.editor, input.selectionStart, input.selectionEnd);
  }
  return true;
}

export function inlineComposerForInput(input: HTMLTextAreaElement): HTMLDivElement | null {
  return composers.get(input)?.editor ?? null;
}

/** Use the browser's editing transaction so the first chip paste can be undone too. */
export function insertInlineComposerText(input: HTMLTextAreaElement, text: string): void {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  let state = composers.get(input);
  if (!state) {
    state = createComposer(input);
    render(state.editor, input.value);
  }
  state.editor.focus();
  restoreSelection(state.editor, start, end);
  insertPlainText(input, state, text);
}
