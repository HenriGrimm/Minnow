import { appChoice } from './app-dialog';
import { normalizeViewerDocText } from './file-viewer-tab-store';

export type ExternalEditChoice = 'reload' | 'merge' | 'keep';

/** Keep both versions for manual reconciliation when edits overlap. */
export function mergeExternalEditDraft(base: string, draft: string, disk: string): string {
  const original = normalizeViewerDocText(base);
  const local = normalizeViewerDocText(draft);
  const external = normalizeViewerDocText(disk);
  if (local === original) return external;
  if (external === original || external === local) return local;
  return `<<<<<<< Your draft\n${local}\n||||||| Loaded version\n${original}\n=======\n${external}\n>>>>>>> Disk version\n`;
}

function comparisonBody(draft: string, disk: string): HTMLElement {
  const body = document.createElement('div');
  body.className = 'file-viewer-external-compare';
  for (const [label, content] of [['Your draft', draft], ['Disk version', disk]]) {
    const column = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = label;
    const text = document.createElement('pre');
    text.textContent = content;
    column.append(heading, text);
    body.appendChild(column);
  }
  return body;
}

/** A conflict never writes to disk; the user chooses how to reconcile the draft. */
export async function chooseExternalEditAction(name: string, draft: string, disk: string): Promise<ExternalEditChoice> {
  const buttons = [
    { id: 'keep', label: 'Keep draft' },
    { id: 'reload', label: 'Reload disk' },
    { id: 'merge', label: 'Merge into draft', primary: true },
  ];
  let showComparison = false;
  while (true) {
    const result = await appChoice({
      title: `${name} changed on disk`,
      message: showComparison
        ? 'Compare the two versions. Merge puts both into your draft with conflict markers for you to resolve; it does not save.'
        : 'An agent, terminal, or another editor changed this file after it was loaded. Your draft is still here.',
      body: showComparison ? comparisonBody(draft, disk) : undefined,
      buttons: showComparison ? buttons : [{ id: 'compare', label: 'Compare' }, ...buttons],
      cancelId: 'keep',
      defaultFocusId: 'keep',
    });
    if (result.id === 'compare') {
      showComparison = true;
      continue;
    }
    return result.id === 'reload' || result.id === 'merge' ? result.id : 'keep';
  }
}
