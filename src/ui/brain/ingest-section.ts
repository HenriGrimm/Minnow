import { runSettingsAction } from '../settings-controls';
import { ingestBrainSource } from '../../brain/client';

let bindingsDone = false;

function setIngestStatus(kind: 'idle' | 'ok' | 'err' | 'spin', message: string): void {
  const el = document.getElementById('brainIngestStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
}

function bindIngestSection(): void {
  if (bindingsDone) return;
  bindingsDone = true;

  document.getElementById('brainIngestSubmit')?.addEventListener('click', () => {
    void runSettingsAction(document.getElementById('brainIngestSubmit'), 'Ingesting…', async () => {
      const titleEl = document.getElementById('brainIngestTitle') as HTMLInputElement | null;
      const fileEl = document.getElementById('brainIngestFilename') as HTMLInputElement | null;
      const bodyEl = document.getElementById('brainIngestBody') as HTMLTextAreaElement | null;
      const resultEl = document.getElementById('brainIngestResult');
      if (!bodyEl || !resultEl) return;

      const content = bodyEl.value.trim();
      if (!content) {
        setIngestStatus('err', 'Paste source content first.');
        return;
      }
      resultEl.replaceChildren();

      const result = await ingestBrainSource({
        content,
        title: titleEl?.value.trim() || undefined,
        filename: fileEl?.value.trim() || undefined,
      });

      if (!result) {
        setIngestStatus('err', 'Ingest failed. Check that Minnow is running and a utility model is configured.');
        return;
      }

      setIngestStatus('idle', `Created or updated ${result.pages.length} page(s).`);
      const list = document.createElement('ul');
      list.className = 'brain-ingest-result';
      for (const path of result.pages) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'brain-inline-link';
        btn.textContent = path;
        btn.addEventListener('click', () => {
          void import('./graph-section').then((m) => {
            m.navigateBrainGraphPage(path);
            void import('../brain-page').then((bp) => bp.openBrain('graph'));
          });
        });
        li.append(btn);
        list.append(li);
      }
      const source = document.createElement('p');
      source.className = 'brain-muted';
      source.textContent = `Stored source: ${result.sourcePath}`;
      resultEl.append(source, list);
    });
  });
}

/** Wire ingest form controls. */
export function renderIngestSection(): void {
  bindIngestSection();
}
