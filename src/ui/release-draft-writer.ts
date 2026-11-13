import { actionApi } from '../state/actions-api';
import { button, el } from './scc-shared';
import { field, statusLine } from './scc-action-form';

interface ReleaseDraftWriterOptions {
  cwd: string | undefined;
  id: number;
  notes: HTMLTextAreaElement;
  onNotesChange: () => void;
  operations: HTMLButtonElement[];
  generate: HTMLButtonElement;
}

/** View-local controls; the model client is loaded only when requested. */
export function createReleaseDraftWriter(options: ReleaseDraftWriterOptions) {
  const root = el('div', 'scc-release-writer');
  const controls = el('div', 'scc-release-writer__controls');
  const base = field('Previous tag override');
  base.placeholder = 'Last published release';
  const range = el('p', 'scc-action-context');
  const status = statusLine();
  status.setAttribute('aria-live', 'polite');
  let active: AbortController | null = null;
  let destroyed = false;
  let previousNotes: string | null = null;
  let locked: [HTMLButtonElement, boolean][] = [];
  const setBusy = (busy: boolean) => {
    options.notes.readOnly = busy;
    write.disabled = undo.disabled = busy;
    cancel.hidden = !busy;
    root.setAttribute('aria-busy', String(busy));
    if (busy) {
      locked = options.operations.map(control => [control, control.disabled]);
      for (const [control] of locked) control.disabled = true;
    } else {
      for (const [control, disabled] of locked) control.disabled = disabled;
      locked = [];
    }
  };
  const stop = () => {
    active?.abort();
    active = null;
    setBusy(false);
    status.textContent = 'Cancelled. Notes kept.';
  };
  const write = button({ label: 'Write draft', onClick: async () => {
    if (active || destroyed) return;
    if (options.operations.some(control => control.disabled)) {
      status.textContent = 'Wait for the current release operation to finish.';
      return;
    }
    const controller = new AbortController();
    active = controller;
    const original = options.notes.value;
    setBusy(true);
    range.textContent = '';
    status.textContent = 'Collecting commit messages…';
    try {
      const result = await actionApi('releaseDraftContext', {
        cwd: options.cwd, id: options.id, previousTag: base.value.trim() || undefined,
      }, controller.signal);
      if (destroyed || active !== controller) return;
      if (!result.ok || !result.draftContext) throw new Error(result.error || 'Could not load release commits.');
      const context = result.draftContext;
      range.textContent = `${context.repo} · ${context.baseTag || 'Initial release'} → ${context.tag} (${context.targetSha.slice(0, 8)}) · ${context.commitCount} commits`;
      if (!context.commitCount) {
        status.textContent = 'No new commits in this release range. Notes kept.';
        return;
      }
      const { writeReleaseDraft } = await import('./release-draft-client');
      if (destroyed || active !== controller) return;
      const text = await writeReleaseDraft(context, controller.signal, message => {
        if (!destroyed && active === controller) status.textContent = message;
      });
      if (destroyed || active !== controller) return;
      previousNotes = original;
      options.notes.value = text;
      undo.hidden = false;
      options.onNotesChange();
      status.textContent = 'Draft ready. Review the notes, then Save changes.';
    } catch (error) {
      if (!destroyed && active === controller)
        status.textContent = `${error instanceof Error ? error.message : String(error)} Notes kept. Select Write draft to retry.`;
    } finally {
      if (active === controller) {
        active = null;
        setBusy(false);
      }
    }
  } });
  const undo = button({ label: 'Undo', onClick: () => {
    if (previousNotes === null || active) return;
    options.notes.value = previousNotes;
    previousNotes = null;
    undo.hidden = true;
    options.onNotesChange();
    status.textContent = 'Previous notes restored. Select Save changes to save them.';
  } });
  const cancel = button({ label: 'Cancel', onClick: stop });
  undo.hidden = cancel.hidden = true;
  base.addEventListener('input', () => {
    if (active) stop();
    range.textContent = '';
  });
  const comparison = el('details', 'scc-release__disclosure');
  comparison.append(el('summary', undefined, 'Previous tag (optional)'), base);
  controls.append(write, options.generate, undo, cancel);
  root.append(controls, comparison, range, status);
  return { root, destroy: () => {
    destroyed = true;
    stop();
  } };
}
