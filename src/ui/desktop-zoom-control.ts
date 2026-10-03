import { createSettingsSelectRow } from './settings-controls';

/** Match electron/shell-zoom.ts; this module also runs in a plain browser. */
const ZOOM_PRESETS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 200];

/** Live, persisted desktop zoom with a disposable shortcut subscription. */
export function mountDesktopZoomControl(mount: HTMLElement): () => void {
  const api = window.minnow?.app?.isElectron ? window.minnow.tray : undefined;
  if (!api?.getZoomPercent || !api.setZoomPercent || !api.onZoomPercentChanged) {
    const hint = document.createElement('p');
    hint.className = 'settings-row__desc';
    hint.textContent = 'Use your browser’s zoom controls to change the interface size.';
    mount.appendChild(hint);
    return () => {};
  }

  const { row, select } = createSettingsSelectRow('Interface zoom', {
    description: 'Scale the desktop interface. Applies immediately. You can also use Ctrl/Cmd + or −.',
    options: ZOOM_PRESETS.map(value => ({ value: String(value), label: `${value}%` })),
    value: '100',
    disabled: true,
  });
  const error = document.createElement('p');
  error.className = 'settings-server-banner';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'settings-action-btn';
  retry.textContent = 'Retry zoom';
  retry.hidden = true;
  mount.append(row, error, retry);

  let disposed = false;
  let current = 100;
  let revision = 0;
  const showPercent = (percent: number) => {
    if (disposed) return;
    current = percent;
    const value = String(percent);
    if (![...select.options].some(option => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${percent}%`;
      select.appendChild(option);
    }
    select.value = value;
  };
  const unsubscribe = api.onZoomPercentChanged(percent => {
    revision += 1;
    showPercent(percent);
  });
  const load = async () => {
    error.hidden = true;
    retry.hidden = true;
    const started = revision;
    try {
      const percent = await api.getZoomPercent();
      if (disposed) return;
      if (revision === started) showPercent(percent);
      select.disabled = false;
    } catch {
      if (disposed) return;
      error.textContent = 'Could not load interface zoom. Retry to adjust it.';
      error.hidden = false;
      retry.hidden = false;
    }
  };
  retry.addEventListener('click', () => void load());
  select.addEventListener('change', () => {
    const requested = Number(select.value);
    select.disabled = true;
    error.hidden = true;
    void api.setZoomPercent(requested).then(showPercent).catch(() => {
      if (disposed) return;
      showPercent(current);
      error.textContent = 'Could not save interface zoom. Try again.';
      error.hidden = false;
    }).finally(() => {
      if (!disposed) select.disabled = false;
    });
  });
  void load();
  return () => { disposed = true; unsubscribe(); };
}
