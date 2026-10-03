import { detectConfigServer } from '../config/storage-mode';
import { appConfirm } from './app-dialog';
import { setStatus } from './status';
import { appendSettingsOfflineHint, createSettingsSelectRow } from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';
import { mountDesktopZoomControl } from './desktop-zoom-control';

function isElectronShell(): boolean {
  return window.minnow?.app?.isElectron === true;
}

function trayApi(): NonNullable<typeof window.minnow>['tray'] | null {
  return window.minnow?.tray ?? null;
}

/** Null on a preload from an older build, which predates the hardware-acceleration IPC. */
function hardwareAccelerationApi() {
  const app = window.minnow?.app;
  if (!app?.getHardwareAcceleration || !app.setHardwareAcceleration || !app.restart) {
    return null;
  }
  return {
    get: app.getHardwareAcceleration.bind(app),
    set: app.setHardwareAcceleration.bind(app),
    restart: app.restart.bind(app),
  };
}

/** Render Desktop app controls into the General settings mount. */
export async function renderDesktopShellSettings(mount: HTMLElement): Promise<void> {
  if (!isElectronShell()) {
    appendSettingsOfflineHint(
      mount,
      'Desktop app settings are available in the Minnow Electron shell.',
    );
    return;
  }

  const api = trayApi();
  if (!api) {
    appendSettingsOfflineHint(mount, 'Update Minnow to a build that includes the system tray.');
    return;
  }

  const serverUp = await detectConfigServer();
  if (serverUp !== 'server') {
    appendSettingsOfflineHint(
      mount,
      'Close-to-tray requires Minnow running locally so preferences can be saved to config.json.',
    );
  }

  const gpuApi = hardwareAccelerationApi();

  const [closeToTray, loginItem, hardwareAcceleration, windowCloseAction] =
    await Promise.all([
      api.getCloseToTray(),
      api.getLoginItem(),
      gpuApi ? gpuApi.get() : Promise.resolve(true),
      api.getWindowCloseAction ? api.getWindowCloseAction() : Promise.resolve(null),
    ]);

  const zoomMount = document.createElement('div');
  zoomMount.dataset.settingsSearchKey = 'general.desktop.zoom';

  const { row: closeRow, input: closeInput } = createSettingsToggleRow(
    'Keep Minnow running after closing the window',
    {
      searchKey: 'general.desktop.closeToTray',
      checked: closeToTray,
      disabled: serverUp !== 'server',
      description:
        'When enabled, closing the window hides Minnow in the system tray so chats and agents keep running.',
    },
  );

  // Absent on a preload from a build before the multi-window close prompt.
  const setWindowCloseAction = api.setWindowCloseAction?.bind(api);
  const closeActionRow =
    windowCloseAction && setWindowCloseAction
      ? createSettingsSelectRow('Closing one of several windows', {
          searchKey: 'general.desktop.windowCloseAction',
          description:
            'With more than one window open, closing one can either close that workspace outright or leave it running in the tray. Its chats and agents keep going in the background, and only workspaces still on screen reopen next launch.',
          options: [
            { value: 'ask', label: 'Ask each time' },
            { value: 'close', label: 'Close the workspace' },
            { value: 'background', label: 'Keep it running in the background' },
          ],
          value: windowCloseAction,
          disabled: serverUp !== 'server',
        })
      : null;

  const loginDescription = loginItem.supported
    ? 'Register Minnow as a login item so it opens when you sign in to this computer.'
    : 'Launch at startup is not supported on this platform.';

  const { row: loginRow, input: loginInput } = createSettingsToggleRow(
    'Launch Minnow at startup',
    {
      searchKey: 'general.desktop.launchAtStartup',
      checked: loginItem.openAtLogin,
      disabled: !loginItem.supported,
      description: loginDescription,
    },
  );

  const gpuRow = gpuApi
    ? createSettingsToggleRow('Hardware acceleration', {
        searchKey: 'general.desktop.hardwareAcceleration',
        checked: hardwareAcceleration,
        description:
          'Render the Minnow interface on the GPU. Turning it off hands the whole GPU to local models, at the cost of a slower interface. Applies after a restart.',
      })
    : null;

  mount.append(zoomMount, closeRow);
  mountDesktopZoomControl(zoomMount);
  if (closeActionRow) mount.append(closeActionRow.row);
  mount.append(loginRow);
  if (gpuRow) mount.append(gpuRow.row);

  closeActionRow?.select.addEventListener('change', () => {
    void (async () => {
      const select = closeActionRow.select;
      const next = select.value;
      if (next !== 'ask' && next !== 'close' && next !== 'background') return;
      try {
        select.value = await setWindowCloseAction!(next);
        setStatus(
          'ok',
          next === 'ask'
            ? 'Minnow will ask before closing a workspace'
            : next === 'close'
              ? 'Closing a window will close its workspace'
              : 'Closing a window will leave its workspace running',
        );
      } catch {
        setStatus('err', 'Could not save desktop preference');
      }
    })();
  });

  closeInput.addEventListener('change', () => {
    void (async () => {
      try {
        const next = await api.setCloseToTray(closeInput.checked);
        closeInput.checked = next;
        setStatus('ok', next ? 'Minnow will stay running in the tray' : 'Closing the window will quit Minnow');
      } catch {
        closeInput.checked = !closeInput.checked;
        setStatus('err', 'Could not save desktop preference');
      }
    })();
  });

  loginInput.addEventListener('change', () => {
    void (async () => {
      try {
        const next = await api.setLoginItem(loginInput.checked);
        loginInput.checked = next.openAtLogin;
        setStatus('ok', next.openAtLogin ? 'Minnow will launch at startup' : 'Startup launch disabled');
      } catch {
        loginInput.checked = !loginInput.checked;
        setStatus('err', 'Could not update startup registration');
      }
    })();
  });

  api.onCloseToTrayChanged((enabled) => {
    closeInput.checked = enabled;
  });

  gpuRow?.input.addEventListener('change', () => {
    void (async () => {
      const input = gpuRow.input;
      const enabled = input.checked;
      try {
        await gpuApi?.set(enabled);
      } catch {
        input.checked = !enabled;
        setStatus('err', 'Could not save hardware acceleration preference');
        return;
      }
      const restartNow = await appConfirm(
        enabled
          ? 'Hardware acceleration will be enabled the next time Minnow starts.'
          : 'Hardware acceleration will be disabled the next time Minnow starts, freeing the GPU for local models.',
        {
          title: 'Restart Minnow?',
          confirmLabel: 'Restart now',
          cancelLabel: 'Later',
        },
      );
      if (!restartNow) {
        setStatus('ok', 'Hardware acceleration applies after the next restart');
        return;
      }
      try {
        await gpuApi?.restart();
      } catch {
        setStatus('err', 'Could not restart Minnow — quit and reopen to apply');
      }
    })();
  });

  const refreshLogin = () => {
    void api.getLoginItem().then((next) => {
      loginInput.checked = next.openAtLogin;
      loginInput.disabled = !next.supported;
    });
  };
  window.addEventListener('focus', refreshLogin);
}
