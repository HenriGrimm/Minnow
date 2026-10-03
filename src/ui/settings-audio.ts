import { detectConfigServer } from '../config/storage-mode';
import { loadVoiceMeta, saveVoiceMeta } from '../config/voice-meta';
import { appendSettingsGroup } from './settings-layout';
import {
  appendSettingsOfflineHint,
  createSettingsActionsRow,
  createSettingsSelectRow,
} from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';

type StatusFn = (kind: 'ok' | 'err' | 'spin', message: string) => void;

/** Request mic permission so device labels are populated. */
async function primeAudioDeviceLabels(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  } catch {
  }
}

async function populateDeviceSelect(
  select: HTMLSelectElement,
  kind: 'audioinput' | 'audiooutput',
  selectedId: string,
): Promise<void> {
  select.replaceChildren();
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent =
    kind === 'audioinput' ? 'System default microphone' : 'System default speaker';
  select.appendChild(defaultOpt);

  if (!navigator.mediaDevices?.enumerateDevices) return;

  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const device of devices) {
    if (device.kind !== kind) continue;
    const opt = document.createElement('option');
    opt.value = device.deviceId;
    opt.textContent =
      device.label ||
      `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} (${device.deviceId.slice(0, 8)}…)`;
    select.appendChild(opt);
  }

  if (selectedId) select.value = selectedId;
}

async function saveAudioSettings(
  inputSelect: HTMLSelectElement,
  outputSelect: HTMLSelectElement,
  echoCb: HTMLInputElement,
  noiseCb: HTMLInputElement,
  agcCb: HTMLInputElement,
): Promise<boolean> {
  const saved = await saveVoiceMeta({
    audio: {
      inputDeviceId: inputSelect.value,
      outputDeviceId: outputSelect.value,
      echoCancellation: echoCb.checked,
      noiseSuppression: noiseCb.checked,
      autoGainControl: agcCb.checked,
    },
  });
  return saved != null;
}

/** Render Settings → Audio controls into a settings mount. */
export async function renderAudioSettingsSection(
  mount: HTMLElement,
  setStatus: StatusFn,
): Promise<void> {
  mount.replaceChildren();

  const serverUp = await detectConfigServer();
  if (!serverUp) {
    appendSettingsOfflineHint(
      mount,
      'Open Minnow to persist audio device settings.',
    );
  }

  const devices = appendSettingsGroup(
    mount,
    'Devices',
    'Choose the microphone and speaker used for dictation and read-aloud.',
    'audio.devices',
    { emphasis: true },
  );

  const inputSelect = document.createElement('select');
  inputSelect.id = 'settingsAudioInputDevice';
  inputSelect.className = 'settings-select';
  inputSelect.disabled = !serverUp;

  const outputSelect = document.createElement('select');
  outputSelect.id = 'settingsAudioOutputDevice';
  outputSelect.className = 'settings-select';
  outputSelect.disabled = !serverUp;

  let echoCb!: HTMLInputElement;
  let noiseCb!: HTMLInputElement;
  let agcCb!: HTMLInputElement;

  const persistAudioSettings = (): void => {
    void (async () => {
      const ok = await saveAudioSettings(inputSelect, outputSelect, echoCb, noiseCb, agcCb);
      if (!ok) {
        setStatus('err', 'Could not save audio settings. Open or restart Minnow.');
        const config = await loadVoiceMeta();
        await populateDeviceSelect(inputSelect, 'audioinput', config.audio.inputDeviceId);
        await populateDeviceSelect(outputSelect, 'audiooutput', config.audio.outputDeviceId);
        echoCb.checked = config.audio.echoCancellation;
        noiseCb.checked = config.audio.noiseSuppression;
        agcCb.checked = config.audio.autoGainControl;
      }
    })();
  };

  const { row: inputRow } = createSettingsSelectRow('Input device', {
    select: inputSelect,
    searchKey: 'audio.inputDevice',
    onChange: () => persistAudioSettings(),
  });
  devices.appendChild(inputRow);

  const { row: outputRow } = createSettingsSelectRow('Output device', {
    select: outputSelect,
    searchKey: 'audio.outputDevice',
    description: 'Choose a speaker when your browser or desktop app supports output selection.',
    onChange: () => persistAudioSettings(),
  });
  devices.appendChild(outputRow);

  const processing = appendSettingsGroup(
    mount,
    'Microphone processing',
    'Improve speech clarity while recording.',
    undefined,
    { emphasis: true },
  );

  const echoToggle = createSettingsToggleRow('Echo cancellation', {
    id: 'settingsAudioEchoCancellation',
    checked: true,
    disabled: !serverUp,
    searchKey: 'audio.echoCancellation',
    onChange: () => persistAudioSettings(),
  });
  echoCb = echoToggle.input;
  processing.appendChild(echoToggle.row);

  const noiseToggle = createSettingsToggleRow('Noise suppression', {
    id: 'settingsAudioNoiseSuppression',
    checked: true,
    disabled: !serverUp,
    searchKey: 'audio.noiseSuppression',
    onChange: () => persistAudioSettings(),
  });
  noiseCb = noiseToggle.input;
  processing.appendChild(noiseToggle.row);

  const agcToggle = createSettingsToggleRow('Auto gain control', {
    id: 'settingsAudioAutoGainControl',
    checked: true,
    disabled: !serverUp,
    searchKey: 'audio.autoGainControl',
    onChange: () => persistAudioSettings(),
  });
  agcCb = agcToggle.input;
  processing.appendChild(agcToggle.row);

  const actions = createSettingsActionsRow(
    [
      {
        label: 'Refresh devices',
        disabled: !serverUp,
        onClick: () => {
          void (async () => {
            setStatus('spin', 'Refreshing devices…');
            await primeAudioDeviceLabels();
            const config = await loadVoiceMeta();
            await populateDeviceSelect(inputSelect, 'audioinput', config.audio.inputDeviceId);
            await populateDeviceSelect(outputSelect, 'audiooutput', config.audio.outputDeviceId);
            setStatus('ok', 'Device list refreshed');
          })();
        },
      },
    ],
    { searchKey: 'audio.devices' },
  );
  mount.appendChild(actions);

  if (!serverUp) return;

  await primeAudioDeviceLabels();
  const config = await loadVoiceMeta();
  await populateDeviceSelect(inputSelect, 'audioinput', config.audio.inputDeviceId);
  await populateDeviceSelect(outputSelect, 'audiooutput', config.audio.outputDeviceId);
  echoCb.checked = config.audio.echoCancellation;
  noiseCb.checked = config.audio.noiseSuppression;
  agcCb.checked = config.audio.autoGainControl;
}
