import {
  EditorSelection,
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Transaction,
} from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { randomUUID } from '../../lib/random-id';
import {
  getEditorAiCompletionConfigSync,
  type EditorAiCompletionConfig,
} from '../../config/editor-ai-completion';
import { nextPartialGhostChunk } from '../editor-ai-completion-prompt';
import {
  completionInsertChangeSpecs,
  dispatchReindentAfterAccept,
  mappedEndAfterInsert,
} from '../editor-completion-accept';
import { recordCompletionEvent } from '../editor-ai-telemetry';
import { recordAcceptedCodeEdit } from '../../usage/code-activity';
import { buildSuggestionDecorations } from './decorations';
import { intentReplaceChangeSpecs } from './intent-accept';
import {
  addAcceptedIntentRegion,
  getAcceptedIntentRegions,
  intentSystemTransaction,
} from './intent-regions';
import { contextHashForRegion } from './intent-context';
import { getEditorIntentModeConfigSync } from '../../config/editor-intent-mode';

/** Where a completion ghost was sourced from. */
export type CompletionSuggestionOrigin = 'stream' | 'cache' | 'test';

/** Inline completion ghost text inserted at {@link CompletionSuggestion.pos}. */
export interface CompletionSuggestion {
  kind: 'completion';
  text: string;
  pos: number;
  id: string;
  shownAt: number;
  origin: CompletionSuggestionOrigin;
  /** Prefix of the model completion already typed through or partial-accepted. */
  consumed: string;
}

/** @deprecated Use {@link CompletionSuggestion}. */
export type AiGhostValue = CompletionSuggestion;

/** Proposed replacement for the document range `[from, to)`. */
export interface IntentSuggestion {
  kind: 'intent';
  from: number;
  to: number;
  intentText: string;
  text: string;
  streaming: boolean;
}

/** Build a completion ghost value for display at the cursor. */
export function createCompletionSuggestion(
  text: string,
  pos: number,
  origin: CompletionSuggestionOrigin,
  previous?: CompletionSuggestion | null,
): CompletionSuggestion {
  if (
    previous &&
    previous.pos === pos &&
    text.startsWith(previous.text) &&
    previous.text.length > 0
  ) {
    return { ...previous, text, origin };
  }
  return {
    kind: 'completion',
    text,
    pos,
    id: randomUUID(),
    shownAt: Date.now(),
    origin,
    consumed: '',
  };
}

export type Suggestion = CompletionSuggestion | IntentSuggestion;

/** Set or clear the visible suggestion. An explicit effect always wins. */
export const setSuggestion = StateEffect.define<Suggestion | null>();

/** File path + config for completion accept (indentRange Layer B). */
export interface CompletionAcceptContext {
  filePath: string;
  getConfig?: () => EditorAiCompletionConfig;
}

export const setCompletionAcceptContext = StateEffect.define<CompletionAcceptContext>();

/** Initial accept context supplied when suggestion extensions are mounted. */
export const completionAcceptContextFacet = Facet.define<
  CompletionAcceptContext,
  CompletionAcceptContext | null
>({
  combine: (values) => values[0] ?? null,
});

export const completionAcceptContextField = StateField.define<CompletionAcceptContext | null>({
  create(state) {
    return state.facet(completionAcceptContextFacet);
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCompletionAcceptContext)) return effect.value;
    }
    return value;
  },
});

/** Toggle Intent mode for one editor. */
export const setIntentEnabled = StateEffect.define<boolean>();

/** Per-editor Intent mode flag (session only — remembered per path by the viewer). */
export const intentEnabledField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setIntentEnabled)) next = effect.value;
    }
    return next;
  },
});

/** Whether Intent mode is active for this editor. */
export function isIntentEnabled(state: EditorState): boolean {
  return state.field(intentEnabledField, false) === true;
}

/** Toggle Intent mode; returns the new enabled flag. */
export function toggleIntentMode(view: EditorView): boolean {
  const next = !isIntentEnabled(view.state);
  view.dispatch({ effects: setIntentEnabled.of(next) });
  return next;
}

/** Set Intent mode explicitly (no-op when already in that state). */
export function setIntentMode(view: EditorView, enabled: boolean): void {
  if (isIntentEnabled(view.state) === enabled) return;
  view.dispatch({ effects: setIntentEnabled.of(enabled) });
}

/** Map an intent anchor through a transaction and re-verify it still covers the text it was generated from. */
function mapIntentSuggestion(
  suggestion: IntentSuggestion,
  tr: Transaction,
): IntentSuggestion | null {
  let { from, to } = suggestion;
  if (tr.docChanged) {
    from = tr.changes.mapPos(from, 1);
    to = tr.changes.mapPos(to, -1);
    if (from >= to) return null;
    if (tr.state.doc.sliceString(from, to) !== suggestion.intentText) return null;
  }
  const head = tr.state.selection.main.head;
  if (head < from || head > to) return null;
  if (from === suggestion.from && to === suggestion.to) return suggestion;
  return { ...suggestion, from, to };
}

/** Resolve the suggestion for a transaction (effects, then invalidation rules). */
export function resolveSuggestionAfterTransaction(
  tr: Transaction,
  startSuggestion: Suggestion | null,
): Suggestion | null {
  let suggestion = startSuggestion;
  let explicitSet = false;
  for (const effect of tr.effects) {
    if (effect.is(setSuggestion)) {
      suggestion = effect.value;
      explicitSet = true;
    }
  }
  if (explicitSet) return suggestion;
  if (!suggestion) return null;

  if (suggestion.kind === 'completion') {
    return mapCompletionSuggestion(suggestion, tr);
  }

  return mapIntentSuggestion(suggestion, tr);
}

const CLOSE_BRACKET_PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
};

/** Split a single-key closeBrackets insert into typed vs auto-closed suffix. */
export function splitCloseBracketInsert(inserted: string): {
  typed: string;
  autoClosed: string;
} {
  if (inserted.length < 2) {
    return { typed: inserted, autoClosed: '' };
  }
  const open = inserted[0]!;
  const expectedClose = CLOSE_BRACKET_PAIRS[open];
  if (!expectedClose || inserted[1] !== expectedClose) {
    return { typed: inserted, autoClosed: '' };
  }
  if (inserted.length === 2) {
    return { typed: open, autoClosed: expectedClose };
  }
  return { typed: inserted, autoClosed: '' };
}

/** Map a completion ghost through a document change (type-through) or keep it on selection-only updates when the cursor stays at the anchor. */
export function mapCompletionSuggestion(
  suggestion: CompletionSuggestion,
  tr: Transaction,
): CompletionSuggestion | null {
  const mappedPos = tr.changes.mapPos(suggestion.pos, 1);

  if (!tr.docChanged) {
    const head = tr.state.selection.main.head;
    if (head === mappedPos) {
      return suggestion.pos === mappedPos ? suggestion : { ...suggestion, pos: mappedPos };
    }
    return null;
  }

  let changeCount = 0;
  let insertFrom = 0;
  let insertTo = 0;
  let inserted = '';
  tr.changes.iterChanges((fromA, toA, fromB, toB, insert) => {
    changeCount += 1;
    insertFrom = fromB;
    insertTo = toB;
    inserted = insert.toString();
  });
  if (changeCount !== 1) return null;
  if (insertTo !== insertFrom + inserted.length) return null;
  if (insertFrom !== tr.changes.mapPos(suggestion.pos, -1)) return null;

  const selection = tr.state.selection.main;
  if (!selection.empty || selection.head !== insertTo) return null;

  const { typed, autoClosed } = splitCloseBracketInsert(inserted);
  if (!typed) return null;
  if (!suggestion.text.startsWith(typed)) return null;

  let remainder = suggestion.text.slice(typed.length);
  if (autoClosed && remainder.startsWith(autoClosed)) {
    remainder = remainder.slice(autoClosed.length);
  }

  const consumed = suggestion.consumed + typed;
  if (!remainder) return null;

  return {
    ...suggestion,
    pos: insertTo,
    text: remainder,
    consumed,
  };
}

interface SuggestionFieldValue {
  suggestion: Suggestion | null;
  decorations: DecorationSet;
}

/** Value + decorations in one field so effect updates always repaint (separate fields can miss decorations when read order races within one transaction). */
export const suggestionField = StateField.define<SuggestionFieldValue>({
  create: () => ({ suggestion: null, decorations: Decoration.none }),
  update(value, tr) {
    const suggestion = resolveSuggestionAfterTransaction(tr, value.suggestion);
    return {
      suggestion,
      decorations: buildSuggestionDecorations(suggestion, tr.state),
    };
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

/** Visible suggestion of any kind, or null. */
export function getSuggestion(state: EditorState): Suggestion | null {
  return state.field(suggestionField, false)?.suggestion ?? null;
}

/** Visible completion ghost, or null. */
export function getCompletionSuggestion(state: EditorState): CompletionSuggestion | null {
  const suggestion = getSuggestion(state);
  return suggestion?.kind === 'completion' && suggestion.text ? suggestion : null;
}

/** Visible intent proposal, or null. */
export function getIntentSuggestion(state: EditorState): IntentSuggestion | null {
  const suggestion = getSuggestion(state);
  return suggestion?.kind === 'intent' && suggestion.text ? suggestion : null;
}

/** True when a completion ghost is visible. */
export function hasCompletionSuggestion(state: EditorState): boolean {
  return getCompletionSuggestion(state) !== null;
}

/** True when an intent proposal is visible. */
export function hasIntentSuggestion(state: EditorState): boolean {
  return getIntentSuggestion(state) !== null;
}

/** True when any suggestion is visible. */
export function hasSuggestion(state: EditorState): boolean {
  return hasCompletionSuggestion(state) || hasIntentSuggestion(state);
}

/** Insert the visible ghost at its anchor and clear suggestion state. */
export function acceptCompletionGhost(view: EditorView): boolean {
  const ghost = getCompletionSuggestion(view.state);
  if (!ghost) return false;
  const insertPos = ghost.pos;
  const ctx = view.state.field(completionAcceptContextField, false);
  const config = ctx?.getConfig?.() ?? getEditorAiCompletionConfigSync();
  const filePath = ctx?.filePath ?? '';
  recordCompletionEvent({ type: 'accepted' });
  const stateBefore = view.state;
  const changes = completionInsertChangeSpecs(
    view.state,
    insertPos,
    ghost.text,
    filePath,
    config,
  );
  const insertedEnd = insertPos + ghost.text.length;
  view.dispatch({
    changes,
    effects: setSuggestion.of(null),
  });
  dispatchReindentAfterAccept(
    view,
    insertPos,
    insertedEnd,
    filePath,
    config,
    ghost.text,
  );
  const mappedEnd = mappedEndAfterInsert(stateBefore, insertPos, view.state);
  recordAcceptedCodeEdit(filePath, '', ghost.text, 'completions');
  view.dispatch({ selection: EditorSelection.cursor(mappedEnd) });
  return true;
}

/** Accept the next word/line chunk from the visible ghost (Ctrl/Cmd-Right). */
export function acceptPartialCompletionGhost(view: EditorView): boolean {
  const ghost = getCompletionSuggestion(view.state);
  if (!ghost) return false;
  const chunk = nextPartialGhostChunk(ghost.text);
  if (!chunk) return false;
  const insertPos = ghost.pos;
  const remainder = ghost.text.slice(chunk.length);
  const ctx = view.state.field(completionAcceptContextField, false);
  const config = ctx?.getConfig?.() ?? getEditorAiCompletionConfigSync();
  const filePath = ctx?.filePath ?? '';
  const stateBefore = view.state;
  const changes = completionInsertChangeSpecs(view.state, insertPos, chunk, filePath, config);
  const insertedEnd = insertPos + chunk.length;
  view.dispatch({
    changes,
    effects: setSuggestion.of(
      remainder
        ? {
            ...ghost,
            consumed: ghost.consumed + chunk,
            text: remainder,
            pos: insertedEnd,
          }
        : null,
    ),
  });
  dispatchReindentAfterAccept(
    view,
    insertPos,
    insertedEnd,
    filePath,
    config,
    chunk,
  );
  const mappedEnd = mappedEndAfterInsert(stateBefore, insertPos, view.state);
  recordAcceptedCodeEdit(filePath, '', chunk, 'completions');
  if (remainder) {
    view.dispatch({
      effects: setSuggestion.of({
        ...ghost,
        consumed: ghost.consumed + chunk,
        text: remainder,
        pos: mappedEnd,
      }),
      selection: EditorSelection.cursor(mappedEnd),
    });
  } else {
    view.dispatch({ selection: EditorSelection.cursor(mappedEnd) });
  }
  return true;
}

/** Replace the intent line with the proposal. */
export function acceptIntentProposal(view: EditorView): boolean {
  const proposal = getIntentSuggestion(view.state);
  if (!proposal) return false;
  const { from, to, text } = proposal;
  if (to > view.state.doc.length) return false;
  if (view.state.doc.sliceString(from, to) !== proposal.intentText) {
    view.dispatch({ effects: setSuggestion.of(null) });
    return false;
  }
  const ctx = view.state.field(completionAcceptContextField, false);
  const config = ctx?.getConfig?.() ?? getEditorAiCompletionConfigSync();
  const filePath = ctx?.filePath ?? '';
  const intentConfig = getEditorIntentModeConfigSync();
  const regions = getAcceptedIntentRegions(view.state);
  const draftRegion = {
    from,
    to: from + text.length,
    intentText: proposal.intentText,
    ctxHash: '',
    stale: false,
  };
  const ctxHash = contextHashForRegion(
    view.state.doc,
    [...regions, draftRegion],
    draftRegion,
    intentConfig.contextWindow,
  );
  const changes = intentReplaceChangeSpecs(view.state, from, to, text, filePath, config);
  view.dispatch({
    annotations: intentSystemTransaction.of(true),
    changes,
    effects: [
      setSuggestion.of(null),
      addAcceptedIntentRegion.of({
        from,
        to: from + text.length,
        intentText: proposal.intentText,
        ctxHash,
        stale: false,
      }),
    ],
    userEvent: 'input.complete',
  });
  const replacedEnd = from + text.length;
  recordAcceptedCodeEdit(filePath, proposal.intentText, text, 'agent');
  const lengthAfterReplace = view.state.doc.length;
  dispatchReindentAfterAccept(view, from, replacedEnd, filePath, config, text);
  const mappedEnd = replacedEnd + (view.state.doc.length - lengthAfterReplace);
  view.dispatch({ selection: EditorSelection.cursor(mappedEnd) });
  return true;
}

/** Clear any visible suggestion without touching the document. */
export function dismissSuggestion(view: EditorView): boolean {
  if (!hasSuggestion(view.state)) return false;
  if (hasCompletionSuggestion(view.state)) {
    recordCompletionEvent({ type: 'dismissed' });
  }
  view.dispatch({ effects: setSuggestion.of(null) });
  return true;
}

/** Test helper: show a completion ghost at the given position. */
export function setCompletionSuggestionForTest(
  view: EditorView,
  text: string,
  pos: number,
): void {
  view.dispatch({
    effects: setSuggestion.of(createCompletionSuggestion(text, pos, 'test')),
  });
}

/** Test helper: show an intent proposal over the given range. */
export function setIntentSuggestionForTest(
  view: EditorView,
  suggestion: Omit<IntentSuggestion, 'kind' | 'streaming'> & { streaming?: boolean },
): void {
  view.dispatch({
    effects: setSuggestion.of({
      kind: 'intent',
      streaming: false,
      ...suggestion,
    }),
  });
}
