import '../styles/settings-general.css';
import '../styles/settings-agent-packs.css';
import {
  downloadAgentPackTemplate,
  downloadBuiltinAgentPack,
  fetchAgentPacksList,
  patchAgentPackEnabled,
  uploadAgentPackZip,
} from '../agents/pack-api';
import type { AgentPackListItem } from '../agents/pack-types';
import { isLocalServerAvailable } from '../tools/config';
import {
  appendSettingsGroup,
  linkToSettingsSection,
} from './settings-layout';
import {
  appendSettingsOfflineHint,
  createSettingsActionsRow,
} from './settings-controls';
import { createSettingsSwitch } from './settings-switch';
import { setStatus } from './status';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Inline monospace path or id in settings copy. */
function codeText(text: string): HTMLElement {
  const code = document.createElement('code');
  code.textContent = text;
  return code;
}

function createSwitch(
  label: string,
  checked: boolean,
  disabled: boolean,
  onChange: (enabled: boolean) => void,
): HTMLLabelElement {
  return createSettingsSwitch({ ariaLabel: label, checked, disabled, onChange }).root;
}

function buildPackRow(
  pack: AgentPackListItem,
  onChange: () => void,
): HTMLLIElement {
  const item = el('li', 'settings-agent-pack-card');
  item.dataset.packId = pack.id;

  const head = el('div', 'settings-agent-pack-card__head');
  const meta = el('div', 'settings-agent-pack-card__meta');

  const titleRow = el('div', 'settings-agent-pack-card__title-row');
  titleRow.appendChild(el('span', 'settings-agent-pack-card__title', pack.label));
  titleRow.appendChild(
    el(
      'span',
      pack.valid
        ? 'settings-agent-pack-card__status settings-agent-pack-card__status--ok'
        : 'settings-agent-pack-card__status settings-agent-pack-card__status--warn',
      pack.valid ? 'Valid' : 'Needs fixes',
    ),
  );
  meta.appendChild(titleRow);

  meta.appendChild(
    el(
      'span',
      'settings-agent-pack-card__meta-line',
      `${pack.id} · v${pack.version} · ${pack.agents.length} agent${pack.agents.length === 1 ? '' : 's'}`,
    ),
  );

  if (pack.description) {
    meta.appendChild(el('p', 'settings-agent-pack-card__desc', pack.description));
  }

  head.appendChild(meta);

  const canToggle = pack.valid && isLocalServerAvailable();
  head.appendChild(
    createSwitch(`Enable ${pack.label}`, pack.enabled, !canToggle, (enabled) => {
      void (async () => {
        try {
          const updated = await patchAgentPackEnabled(pack.id, enabled);
          if (!updated) {
            setStatus('err', 'Could not update pack (Minnow must be running)');
            return;
          }
          setStatus('ok', `Pack "${pack.label}" ${enabled ? 'enabled' : 'disabled'}`);
          onChange();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Update failed';
          setStatus('err', message);
        }
      })();
    }),
  );

  item.appendChild(head);

  if (!pack.valid && pack.errors.length) {
    const errList = el('ul', 'settings-agent-pack-card__errors');
    for (const msg of pack.errors) {
      errList.appendChild(el('li', undefined, msg));
    }
    item.appendChild(errList);
  }

  const pathHint = el('p', 'settings-agent-pack-card__path');
  pathHint.append('Folder: ', codeText(pack.packRoot));
  item.appendChild(pathHint);

  return item;
}

/** Step list for creating a pack from the downloadable template. */
function appendAuthoringSteps(mount: HTMLElement): void {
  const steps = el('ol', 'settings-agent-packs-steps');
  steps.setAttribute('aria-label', 'How to create an agent pack');

  const stepItems = [
    [
      'Download the starter template, or export the ',
      linkToSettingsSection('built-in work agents', 'agent-center'),
      ' as a pack with ',
      codeText('Download default pack'),
      '. You can also copy ',
      codeText('~/.minnow/agent-packs/_template'),
      ' after your first ',
      codeText('Minnow app'),
      '.',
    ],
    [
      'Rename the folder and set the same id in ',
      codeText('manifest.json'),
      ' (pattern ',
      codeText('^[a-z][a-z0-9-]{0,63}$'),
      '). Folders starting with ',
      codeText('_'),
      ' are ignored.',
    ],
    [
      'Edit prompts under ',
      codeText('prompts/'),
      ', adjust ',
      codeText('allowedTools'),
      ', and add more agents in ',
      codeText('manifest.json'),
      '.',
    ],
    [
      'Upload a ',
      codeText('.zip'),
      ' with ',
      codeText('Upload pack'),
      ' below, or place the folder in ',
      codeText('~/.minnow/agent-packs/<pack-id>/'),
      ' and click Refresh.',
    ],
    [
      'Enable the pack here. Agents appear in ',
      linkToSettingsSection('Agents', 'agent-center'),
      ' as ',
      codeText('packId.agentKey'),
      ' work agents.',
    ],
  ];

  for (const parts of stepItems) {
    const li = document.createElement('li');
    for (const part of parts) {
      if (typeof part === 'string') {
        li.appendChild(document.createTextNode(part));
      } else {
        li.appendChild(part);
      }
    }
    steps.appendChild(li);
  }

  mount.appendChild(steps);
}

/** Render Agent packs content into a settings-general content column. */
export async function renderAgentPacksSettingsSection(content: HTMLElement): Promise<void> {
  content.replaceChildren();

  /** Refreshes the installed pack list when upload completes. */
  let refreshPackList: (() => void) | null = null;

  const authorBody = appendSettingsGroup(
    content,
    'Add an agent pack',
    'Upload a ZIP file to add its agents to Minnow.',
    'agents.agentPacks.author',
    { emphasis: true },
  );

  const authorDetails = el('details', 'settings-disclosure');
  authorDetails.appendChild(el('summary', undefined, 'Create your own pack'));
  const authorInstructions = el('div');
  authorDetails.appendChild(authorInstructions);
  appendAuthoringSteps(authorInstructions);

  const schemaHint = el('p', 'settings-agent-pack-card__path');
  schemaHint.append(
    'Manifest fields are validated at scan time. See ',
    codeText('documentation/agent-packs/README.md'),
    ' and ',
    codeText('src/agents/schema/agent-pack.schema.json'),
    '.',
  );
  authorInstructions.appendChild(schemaHint);

  authorInstructions.appendChild(
    createSettingsActionsRow(
      [
        {
          label: 'Download template',
          variant: 'primary',
          disabled: !isLocalServerAvailable(),
          onClick: () => {
            void (async () => {
              const result = await downloadAgentPackTemplate();
              if (result === true) {
                setStatus('ok', 'Agent pack template downloaded');
                return;
              }
              setStatus('err', result.message);
            })();
          },
        },
        {
          label: 'Download default pack',
          disabled: !isLocalServerAvailable(),
          onClick: () => {
            void (async () => {
              const result = await downloadBuiltinAgentPack();
              if (result === true) {
                setStatus('ok', 'Default Minnow agent pack downloaded');
                return;
              }
              setStatus('err', result.message);
            })();
          },
        },
      ],
      { searchKey: 'agents.agentPacks.download' },
    ),
  );

  const defaultPackHint = el('p', 'settings-agent-pack-card__path');
  defaultPackHint.append(
    'Default pack exports all shipped work agents (Builder, Planner, Reviewer, etc.) as ',
    codeText('minnow/<agent-key>/'),
    ' prompts. Install to ',
    codeText('~/.minnow/agent-packs/minnow/'),
    ' to customize without losing upstream updates.',
  );
  authorInstructions.appendChild(defaultPackHint);

  const uploadInput = document.createElement('input');
  uploadInput.type = 'file';
  uploadInput.accept = '.zip,application/zip';
  uploadInput.className = 'settings-agent-packs-upload-input';
  uploadInput.setAttribute('aria-hidden', 'true');
  uploadInput.tabIndex = -1;

  authorBody.appendChild(uploadInput);

  authorBody.appendChild(
    createSettingsActionsRow(
      [
        {
          label: 'Upload pack',
          variant: 'primary',
          disabled: !isLocalServerAvailable(),
          onClick: () => uploadInput.click(),
        },
      ],
      { searchKey: 'agents.agentPacks.upload' },
    ),
  );

  const uploadHint = el('p', 'settings-agent-pack-card__path');
  uploadHint.append(
    'Choose a ZIP containing the pack folder and its ',
    codeText('manifest.json'),
    ' file. Minnow checks the pack before you enable it.',
  );
  authorBody.appendChild(uploadHint);
  authorBody.appendChild(authorDetails);

  uploadInput.addEventListener('change', () => {
    const file = uploadInput.files?.[0];
    uploadInput.value = '';
    if (!file) return;

    void (async () => {
      setStatus('spin', `Installing ${file.name}…`);
      const result = await uploadAgentPackZip(file);
      if (result.ok === false) {
        setStatus('err', result.error);
        return;
      }
      const { pack, filesWritten } = result;
      if (pack.valid) {
        setStatus(
          'ok',
          `Installed "${pack.label}" (${filesWritten} files). Enable it in Installed packs when ready.`,
        );
      } else {
        setStatus(
          'ok',
          `Installed "${pack.label}" with validation issues — fix the listed errors before enabling.`,
        );
      }
      refreshPackList?.();
    })();
  });

  if (!isLocalServerAvailable()) {
    appendSettingsOfflineHint(
      authorBody,
      'Open Minnow to download the template, scan packs, and toggle enablement.',
    );
  }

  const listBody = appendSettingsGroup(
    content,
    'Installed packs',
    'Enable the packs you want to use. Their agents appear in the composer.',
    'agents.agentPacks.installed',
    { emphasis: true },
  );

  content.prepend(listBody.parentElement!);

  if (!isLocalServerAvailable()) {
    appendSettingsOfflineHint(
      listBody,
      'Pack list requires Minnow running locally.',
    );
    return;
  }

  const list = el('ul', 'settings-agent-packs-list');

  const renderList = async (): Promise<void> => {
    list.replaceChildren();
    try {
      const packs = await fetchAgentPacksList();
      if (!packs.length) {
        const empty = el('li', 'settings-agent-packs-empty');
        empty.append(
          'No packs installed yet. Upload a ',
          codeText('.zip'),
          ' file below, or expand Create your own pack to get started.',
        );
        list.appendChild(empty);
        return;
      }
      for (const pack of packs) {
        list.appendChild(buildPackRow(pack, () => void renderList()));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load packs';
      list.appendChild(el('li', 'settings-agent-packs-empty', message));
    }
  };

  listBody.appendChild(list);
  await renderList();
  refreshPackList = () => {
    void renderList();
  };

  listBody.appendChild(
    createSettingsActionsRow(
      [
        {
          label: 'Refresh pack list',
          onClick: () => {
            void renderList();
            setStatus('ok', 'Agent pack list refreshed');
          },
        },
      ],
      { searchKey: 'agents.agentPacks.refresh' },
    ),
  );
}
