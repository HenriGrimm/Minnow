import { runSettingsAction } from '../settings-controls';
import { fetchBrainSchema, saveBrainSchema } from '../../brain/client';

let bindingsDone = false;
let previewBound = false;

function setSchemaStatus(kind: 'idle' | 'ok' | 'err' | 'spin', message: string): void {
  const el = document.getElementById('brainSchemaStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
}

function refreshSchemaPreview(): void {
  const editor = document.getElementById('brainSchemaEditor') as HTMLTextAreaElement | null;
  const preview = document.getElementById('brainSchemaPreview');
  if (!editor || !preview) return;
  const text = editor.value.trim();
  preview.textContent = text || 'Edit schema.md to define wiki taxonomy fields and tags.';
}

function bindSchemaSection(): void {
  if (bindingsDone) return;
  bindingsDone = true;

  document.getElementById('brainSchemaReload')?.addEventListener('click', () => {
    void renderSchemaSection();
  });

  document.getElementById('brainSchemaSave')?.addEventListener('click', () => {
    void runSettingsAction(document.getElementById('brainSchemaSave'), 'Saving…', async () => {
      const editor = document.getElementById(
        'brainSchemaEditor',
      ) as HTMLTextAreaElement | null;
      if (!editor) return;
      const ok = await saveBrainSchema(editor.value);
      setSchemaStatus(ok ? 'idle' : 'err', ok ? 'Schema saved.' : 'Save failed.');
    });
  });
}

function bindSchemaPreview(): void {
  if (previewBound) return;
  previewBound = true;
  const editor = document.getElementById('brainSchemaEditor');
  editor?.addEventListener('input', refreshSchemaPreview);
}

/** Load schema.md into the editor. */
export async function renderSchemaSection(): Promise<void> {
  bindSchemaSection();
  bindSchemaPreview();
  const editor = document.getElementById('brainSchemaEditor') as HTMLTextAreaElement | null;
  const offlineEl = document.getElementById('brainSchemaOffline');
  if (!editor) return;

  const schema = await fetchBrainSchema();
  const online = schema !== null;
  offlineEl?.classList.toggle('hidden', online);

  if (!online) {
    editor.value = '';
    editor.disabled = true;
    refreshSchemaPreview();
    setSchemaStatus('err', 'Offline — open Minnow.');
    return;
  }

  editor.disabled = false;
  editor.value = schema ?? '';
  refreshSchemaPreview();
  setSchemaStatus('idle', 'Schema loaded.');
}
