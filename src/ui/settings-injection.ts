import {
  fetchCodeMapInjectionDefault,
  saveCodeMapInjectionDefault,
} from '../brain/code-injection-config';
import {
  fetchMemoryInjectionEnabled,
  saveMemorySettings,
} from '../memory/config';
import { syncComposerBrainNotesFromActiveChat } from './composer-brain-notes';
import { syncComposerCodeMapFromActiveChat } from './composer-code-map';
import { syncComposerContextDocumentsFromActiveChat } from './composer-context-documents';
import { renderContextDocumentsInjectionSection } from './settings-context-documents';
import { appendSettingsGroup } from './settings-layout';
import { createSettingsToggleRow } from './settings-switch';

type StatusFn = (kind: 'ok' | 'err' | 'spin', message: string) => void;

function refreshComposerInjectionControls(): void {
  void Promise.all([
    syncComposerBrainNotesFromActiveChat(),
    syncComposerCodeMapFromActiveChat(),
    syncComposerContextDocumentsFromActiveChat(),
  ]);
}

/** Render the global defaults for optional prompt context under Agents → Injection. */
export async function renderInjectionSettingsSection(
  mount: HTMLElement,
  setStatus: StatusFn,
): Promise<void> {
  mount.replaceChildren();

  const shell = document.createElement('div');
  shell.className = 'settings-general';
  mount.appendChild(shell);

  const lead = document.createElement('p');
  lead.className = 'settings-section-lead';
  lead.textContent =
    'Choose which optional project context is added to the first message by default. Each source can still be overridden per chat from the composer.';
  shell.appendChild(lead);

  const content = document.createElement('div');
  content.className = 'settings-general__content';
  shell.appendChild(content);

  const [initialBrainNotesDefault, initialCodeMapDefault] = await Promise.all([
    fetchMemoryInjectionEnabled(),
    fetchCodeMapInjectionDefault(),
  ]);
  let brainNotesDefault = initialBrainNotesDefault;
  let codeMapDefault = initialCodeMapDefault;

  const defaults = appendSettingsGroup(
    content,
    'Composer sources',
    'These defaults control whether the matching source appears in the composer and is included on send.',
    'agents.injection',
    { emphasis: true },
  );

  const { row: brainNotesRow, input: brainNotesInput } = createSettingsToggleRow(
    'Inject Brain notes by default',
    {
      id: 'settingsBrainNotesInjectionDefault',
      checked: brainNotesDefault,
      searchKey: 'agents.injection.brainNotes',
      description: 'The Brain notes composer toggle is available when this is enabled.',
      onChange: (checked) => {
        void (async () => {
          const ok = await saveMemorySettings({ injectionEnabled: checked });
          if (!ok) {
            brainNotesInput.checked = brainNotesDefault;
            setStatus('err', 'Could not save Brain notes injection setting');
            return;
          }
          brainNotesDefault = checked;
          setStatus('ok', 'Brain notes injection setting saved');
          refreshComposerInjectionControls();
        })();
      },
    },
  );
  defaults.appendChild(brainNotesRow);

  const { row: codeMapRow, input: codeMapInput } = createSettingsToggleRow(
    'Inject code map by default',
    {
      id: 'settingsCodeMapInjectionDefault',
      checked: codeMapDefault,
      searchKey: 'agents.injection.codeMap',
      description: 'The code-map composer toggle is available when this is enabled.',
      onChange: (checked) => {
        void (async () => {
          const ok = await saveCodeMapInjectionDefault(checked);
          if (!ok) {
            codeMapInput.checked = codeMapDefault;
            setStatus('err', 'Could not save code-map injection setting');
            return;
          }
          codeMapDefault = checked;
          setStatus('ok', 'Code-map injection setting saved');
          refreshComposerInjectionControls();
        })();
      },
    },
  );
  defaults.appendChild(codeMapRow);

  await renderContextDocumentsInjectionSection(content, setStatus);
}
