import {
  CRON_PATTERN_OPTIONS,
  SCHEDULE_KIND_OPTIONS,
  cronUiToExpression,
  describeSchedule,
  previewNextCronRun,
  scheduleToUi,
  uiToSchedule,
  validateScheduleUi,
  WEEKDAY_LABELS,
  type CronPattern,
  type ScheduleUiState,
} from '../../scheduler/schedule-display';

export interface ScheduleFieldMount {
  root: HTMLElement;
  getState: () => ScheduleUiState;
  setState: (schedule: { kind: 'interval' | 'cron'; value: string }) => void;
  refreshPreview: () => void;
}

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

function padTimePart(value: number): string {
  return String(value).padStart(2, '0');
}

/** Mount the schedule field controls into `container`. */
export function mountScheduleField(
  container: HTMLElement,
  initial: { kind: 'interval' | 'cron'; value: string },
  onChange: (schedule: { kind: 'interval' | 'cron'; value: string }) => void,
): ScheduleFieldMount {
  let ui = scheduleToUi(initial);

  const root = el('div', 'scheduler-schedule-field');
  container.appendChild(root);

  const kindRow = el('div', 'scheduler-schedule-kind-row');
  const kindSelect = el('select', 'settings-select scheduler-schedule-kind') as HTMLSelectElement;
  for (const option of SCHEDULE_KIND_OPTIONS) {
    const opt = el('option', undefined, option.label) as HTMLOptionElement;
    opt.value = option.value;
    kindSelect.appendChild(opt);
  }
  kindRow.appendChild(kindSelect);
  root.appendChild(kindRow);

  const intervalPanel = el('div', 'scheduler-schedule-panel scheduler-schedule-panel--interval');
  const intervalInput = el('input', 'scheduler-input scheduler-schedule-interval') as HTMLInputElement;
  intervalInput.type = 'text';
  intervalInput.placeholder = '5m';
  intervalInput.setAttribute('inputmode', 'text');
  intervalInput.setAttribute('autocomplete', 'off');
  intervalPanel.appendChild(intervalInput);
  intervalPanel.appendChild(
    el('span', 'scheduler-field__hint', 'Examples: 5m, 30m, 2h. Minimum 60 seconds between runs.'),
  );
  root.appendChild(intervalPanel);

  const cronPanel = el('div', 'scheduler-schedule-panel scheduler-schedule-panel--cron hidden');
  const patternSelect = el('select', 'settings-select scheduler-cron-pattern') as HTMLSelectElement;
  for (const option of CRON_PATTERN_OPTIONS) {
    const opt = el('option', undefined, option.label) as HTMLOptionElement;
    opt.value = option.value;
    patternSelect.appendChild(opt);
  }
  cronPanel.appendChild(patternSelect);

  const timeRow = el('label', 'scheduler-cron-time-row');
  timeRow.appendChild(el('span', 'scheduler-field__label', 'Time'));
  const timeInput = el('input', 'scheduler-input scheduler-cron-time') as HTMLInputElement;
  timeInput.type = 'time';
  timeRow.appendChild(timeInput);
  cronPanel.appendChild(timeRow);

  const minuteRow = el('label', 'scheduler-cron-minute-row hidden');
  minuteRow.appendChild(el('span', 'scheduler-field__label', 'Minute past the hour'));
  const minuteInput = el('input', 'scheduler-input scheduler-cron-minute') as HTMLInputElement;
  minuteInput.type = 'number';
  minuteInput.min = '0';
  minuteInput.max = '59';
  minuteInput.step = '1';
  minuteRow.appendChild(minuteInput);
  cronPanel.appendChild(minuteRow);

  const weekRow = el('fieldset', 'scheduler-cron-weekdays hidden');
  weekRow.appendChild(el('legend', 'scheduler-field__label', 'Days'));
  const weekButtons = el('div', 'scheduler-cron-weekday-grid');
  const dayToggleInputs: HTMLInputElement[] = [];
  WEEKDAY_LABELS.forEach((label, dayIndex) => {
    const toggle = el('label', 'scheduler-cron-weekday');
    const input = el('input') as HTMLInputElement;
    input.type = 'checkbox';
    input.value = String(dayIndex);
    input.className = 'scheduler-cron-weekday__input';
    const face = el('span', 'scheduler-cron-weekday__face', label);
    toggle.append(input, face);
    weekButtons.appendChild(toggle);
    dayToggleInputs.push(input);
  });
  weekRow.appendChild(weekButtons);
  cronPanel.appendChild(weekRow);

  const customBlock = el('div', 'scheduler-cron-custom hidden');
  customBlock.appendChild(el('span', 'scheduler-field__label', 'Cron expression'));
  const customInput = el('input', 'scheduler-input scheduler-cron-custom-input') as HTMLInputElement;
  customInput.type = 'text';
  customInput.placeholder = '0 9 * * 1-5';
  customInput.setAttribute('spellcheck', 'false');
  customBlock.appendChild(customInput);
  customBlock.appendChild(
    el(
      'span',
      'scheduler-field__hint',
      'Five fields: minute, hour, day of month, month, day of week. Uses your computer local time.',
    ),
  );
  cronPanel.appendChild(customBlock);

  root.appendChild(cronPanel);

  const preview = el('p', 'scheduler-schedule-preview');
  preview.setAttribute('role', 'status');
  preview.setAttribute('aria-live', 'polite');
  root.appendChild(preview);

  function emitChange(): void {
    onChange(uiToSchedule(ui));
    refreshPreview();
  }

  function readTimeInput(): void {
    const parts = timeInput.value.split(':');
    if (parts.length !== 2) return;
    const hour = Number.parseInt(parts[0], 10);
    const minute = Number.parseInt(parts[1], 10);
    if (Number.isFinite(hour)) ui.cron.hour = hour;
    if (Number.isFinite(minute)) ui.cron.minute = minute;
  }

  function writeTimeInput(): void {
    timeInput.value = `${padTimePart(ui.cron.hour)}:${padTimePart(ui.cron.minute)}`;
  }

  function readWeekDays(): void {
    ui.cron.weekDays = dayToggleInputs
      .filter((input) => input.checked)
      .map((input) => Number.parseInt(input.value, 10))
      .filter((day) => day >= 0 && day <= 6);
  }

  function writeWeekDays(): void {
    const selected = new Set(ui.cron.weekDays);
    for (const input of dayToggleInputs) {
      input.checked = selected.has(Number.parseInt(input.value, 10));
    }
  }

  function syncCronPanels(): void {
    const pattern = ui.cron.pattern;
    timeRow.classList.toggle('hidden', pattern === 'hourly' || pattern === 'custom');
    minuteRow.classList.toggle('hidden', pattern !== 'hourly');
    weekRow.classList.toggle('hidden', pattern !== 'weekly');
    customBlock.classList.toggle('hidden', pattern !== 'custom');
  }

  function syncKindPanels(): void {
    const isInterval = ui.kind === 'interval';
    intervalPanel.classList.toggle('hidden', !isInterval);
    cronPanel.classList.toggle('hidden', isInterval);
  }

  function refreshPreview(): void {
    const validation = validateScheduleUi(ui);
    if (validation.ok === false) {
      preview.textContent = validation.error;
      preview.classList.add('is-err');
      return;
    }

    const schedule = uiToSchedule(ui);
    preview.classList.remove('is-err');

    if (schedule.kind === 'interval') {
      preview.textContent = `${describeSchedule(schedule)} while Minnow is open.`;
      return;
    }

    const expression = cronUiToExpression(ui.cron);
    const next = previewNextCronRun(expression);
    if (next.ok === false) {
      preview.textContent = next.error;
      preview.classList.add('is-err');
      return;
    }

    const summary = describeSchedule(schedule);
    preview.textContent = `${summary}. Next run: ${next.nextLabel} (local time).`;
  }

  function paint(): void {
    kindSelect.value = ui.kind;
    intervalInput.value = ui.intervalValue;
    patternSelect.value = ui.cron.pattern;
    minuteInput.value = String(ui.cron.minute);
    writeTimeInput();
    writeWeekDays();
    customInput.value = ui.cron.customExpression;
    syncKindPanels();
    syncCronPanels();
    refreshPreview();
  }

  kindSelect.addEventListener('change', () => {
    ui.kind = kindSelect.value as ScheduleUiState['kind'];
    syncKindPanels();
    emitChange();
  });

  intervalInput.addEventListener('input', () => {
    ui.intervalValue = intervalInput.value;
    emitChange();
  });

  patternSelect.addEventListener('change', () => {
    ui.cron.pattern = patternSelect.value as CronPattern;
    syncCronPanels();
    emitChange();
  });

  timeInput.addEventListener('input', () => {
    readTimeInput();
    emitChange();
  });

  minuteInput.addEventListener('input', () => {
    const minute = Number.parseInt(minuteInput.value, 10);
    if (Number.isFinite(minute)) ui.cron.minute = minute;
    emitChange();
  });

  for (const input of dayToggleInputs) {
    input.addEventListener('change', () => {
      readWeekDays();
      emitChange();
    });
  }

  customInput.addEventListener('input', () => {
    ui.cron.customExpression = customInput.value;
    emitChange();
  });

  paint();

  return {
    root,
    getState: () => structuredClone(ui),
    setState: (schedule) => {
      ui = scheduleToUi(schedule);
      paint();
    },
    refreshPreview,
  };
}
