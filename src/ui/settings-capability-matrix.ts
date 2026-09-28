import '../styles/settings-general.css';
import '../styles/settings-capability-matrix.css';
import { detectConfigServer } from '../config/storage-mode';
import { loadCampaign } from '../benchmark/campaign-persistence.ts';
import {
  clearManualVerdicts,
  loadManualVerdicts,
} from '../benchmark/capabilities/manual-verdicts.ts';
import {
  loadCapabilityMatrixRoster,
  saveCapabilityMatrixRoster,
  type CapabilityMatrixRosterEntry,
} from '../benchmark/capabilities/roster-store.ts';
import { buildCapabilityMatrixViewModel } from '../benchmark/capabilities/view-model.ts';
import {
  CAPABILITY_MATRIX_PROBE_WAVES,
  allCapabilityGroupIds,
} from '../benchmark/capabilities/matrix-run-filters.ts';
import {
  disposeCapabilityMatrixRunView,
  findInFlightCapabilityProbeLookup,
  getCapabilityMatrixCurrentProbe,
  getCapabilityMatrixInFlightAutos,
  resumeCapabilityMatrixRunFromCampaign,
  subscribeCapabilityMatrixProbeUpdates,
  subscribeCapabilityMatrixRun,
} from '../benchmark/capabilities/matrix-run-controller.ts';
import type { BenchmarkCampaign, BenchmarkCampaignSummary } from '../benchmark/campaign-types.ts';
import { canResumeCapabilityMatrixCampaign } from '../benchmark/capabilities/resume-from-campaign.ts';
import {
  beginAsyncSectionRender,
  isAsyncSectionRenderStale,
} from './settings-section-render-guard';
import {
  appendSettingsDangerZone,
  appendSettingsOfflineHint,
  createSettingsActionsRow,
} from './settings-controls';
import { appConfirm } from './app-dialog';
import { downloadCapabilityMatrixXlsx } from './capability-matrix/export-xlsx.ts';
import { importCapabilityMatrixXlsxFile } from './capability-matrix/import-xlsx.ts';
import { openCapabilityCellTranscript, refreshCapabilityCellTranscript } from './capability-matrix/cell-transcript.ts';
import { renderCapabilityMatrixGrid } from './capability-matrix/grid.ts';
import {
  createDefaultGridFilter,
  mountCapabilityGridToolbar,
  type CapabilityGridFilter,
} from './capability-matrix/grid-toolbar.ts';
import {
  loadCapabilityMatrixCampaignSummaries,
  renderCapabilityMatrixHistory,
} from './capability-matrix/history-panel.ts';
import { renderCapabilityRosterPanel } from './capability-matrix/roster-panel.ts';
import { mountCapabilityRunPanel } from './capability-matrix/run-panel.ts';
import { setStatus } from './status';
import { closeBenchmarkTranscriptDrawer, isBenchmarkTranscriptDrawerOpen } from './benchmark-transcript-drawer.ts';

const disposers: Array<() => void> = [];
let disposeRunPanel: (() => void) | null = null;
let refreshRunPanelBanners: (() => void) | null = null;
let disposeGridNav: (() => void) | null = null;
let disposeGridToolbar: (() => void) | null = null;
let disposeProbeUpdates: (() => void) | null = null;
let disposeRunSubscription: (() => void) | null = null;
let gridFilter: CapabilityGridFilter = createDefaultGridFilter();

/** Tear down listeners and child editors before re-render or navigation. */
export function disposeCapabilityMatrix(): void {
  disposeRunPanel?.();
  disposeRunPanel = null;
  refreshRunPanelBanners = null;
  disposeGridNav?.();
  disposeGridNav = null;
  disposeGridToolbar?.();
  disposeGridToolbar = null;
  disposeProbeUpdates?.();
  disposeProbeUpdates = null;
  disposeRunSubscription?.();
  disposeRunSubscription = null;
  closeBenchmarkTranscriptDrawer();
  disposeCapabilityMatrixRunView();
  while (disposers.length) {
    disposers.pop()?.();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clearMount(id: string): HTMLElement | null {
  const mount = document.getElementById(id);
  if (!mount) return null;
  mount.replaceChildren();
  return mount;
}

async function loadCampaignBodies(
  ids: string[],
): Promise<BenchmarkCampaign[]> {
  const campaigns: BenchmarkCampaign[] = [];
  for (const id of ids) {
    const row = await loadCampaign(id);
    if (row) campaigns.push(row);
  }
  return campaigns;
}

/** Load data, merge grid, and mount the workbench layout. */
export async function renderCapabilityMatrixSettingsSection(): Promise<void> {
  disposeCapabilityMatrix();
  gridFilter = createDefaultGridFilter();
  const generation = beginAsyncSectionRender('capability-matrix');

  const mount = clearMount('settingsCapabilityMatrixBody');
  if (!mount) return;

  const shell = el('div', 'settings-general settings-general--wide cap-matrix-shell');
  mount.appendChild(shell);

  const commandBar = el('div', 'cap-matrix-command-bar');
  const commandCopy = el('div', 'cap-matrix-command-bar__copy');
  commandCopy.appendChild(
    el(
      'p',
      'settings-section-lead cap-matrix-command-bar__lead',
      'Compare model capability across your roster. Click a cell for the probe transcript and a manual verdict.',
    ),
  );
  commandCopy.appendChild(
    el(
      'p',
      'settings-field-hint cap-matrix-command-bar__hint',
      'Export uses SheetJS in the browser. Only cell values and catalog headers are included.',
    ),
  );

  const headerActions = createSettingsActionsRow(
    [
      {
        label: 'Export .xlsx',
        variant: 'default',
        onClick: () => {
          try {
            downloadCapabilityMatrixXlsx(viewModel, roster, latestManualStore);
            setStatus('ok', 'Workbook downloaded');
          } catch (err) {
            setStatus('err', err instanceof Error ? err.message : 'Export failed');
          }
        },
      },
    ],
    { searchKey: 'advanced.capabilityMatrix.export' },
  );
  headerActions.classList.add('cap-matrix-command-bar__actions');
  const exportBtn = headerActions.querySelector('button');
  if (exportBtn) {
    exportBtn.dataset.settingsSearchKey = 'advanced.capabilityMatrix.export';
  }

  const importLabel = el('label', 'settings-action-btn settings-action-btn--secondary');
  importLabel.textContent = 'Import .xlsx';
  importLabel.dataset.settingsSearchKey = 'advanced.capabilityMatrix.import';
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  importInput.hidden = true;
  importLabel.appendChild(importInput);
  headerActions.appendChild(importLabel);

  commandBar.append(commandCopy, headerActions);
  shell.appendChild(commandBar);

  const serverUp = (await detectConfigServer()) === 'server';
  if (isAsyncSectionRenderStale('capability-matrix', generation)) return;

  if (!serverUp) {
    appendSettingsOfflineHint(
      shell,
      'Roster and verdicts sync when Minnow is running locally (npm start).',
    );
  }

  const content = el('div', 'settings-general__content cap-matrix-workbench');
  shell.appendChild(content);

  const body = el('div', 'cap-matrix-workbench__body');

  const rail = el('aside', 'cap-matrix-rail');
  rail.dataset.settingsSearchKey = 'advanced.capabilityMatrix.roster';

  const rosterDrawer = el('details', 'cap-matrix-rail__drawer');
  rosterDrawer.open = true;
  const rosterSummary = el('summary', 'cap-matrix-rail__drawer-summary', 'Models');
  rosterSummary.appendChild(
    el('span', 'cap-matrix-rail__drawer-hint', 'Cloud, LM Studio, or Minnow Hosting'),
  );
  const rosterBody = el('div', 'cap-matrix-rail__drawer-body');
  const rosterHost = el('div', 'cap-matrix-roster-host');
  rosterBody.appendChild(rosterHost);
  rosterDrawer.append(rosterSummary, rosterBody);

  const runDrawer = el('details', 'cap-matrix-rail__drawer');
  runDrawer.open = true;
  runDrawer.dataset.settingsSearchKey = 'advanced.capabilityMatrix.run';
  const runSummary = el('summary', 'cap-matrix-rail__drawer-summary', 'Run probes');
  runSummary.appendChild(
    el(
      'span',
      'cap-matrix-rail__drawer-hint',
      'Groups, waves, and sweep options',
    ),
  );
  const runBody = el('div', 'cap-matrix-rail__drawer-body');
  const runHost = el('div', 'cap-matrix-run-host');
  runBody.appendChild(runHost);
  runDrawer.append(runSummary, runBody);

  const historyHost = el('div', 'cap-matrix-history-host');
  const railFooter = el('div', 'cap-matrix-rail__footer');
  railFooter.appendChild(historyHost);

  rail.append(rosterDrawer, runDrawer, railFooter);

  const main = el('main', 'cap-matrix-main');
  main.dataset.settingsSearchKey = 'advanced.capabilityMatrix.grid';
  const gridToolbarHost = el('div', 'cap-matrix-grid-toolbar-host');
  const gridHost = el('div', 'cap-matrix-grid-host');
  const viewBannerHostEl = el('div', 'cap-matrix-view-banner-host');
  viewBannerHostEl.hidden = true;
  main.append(viewBannerHostEl, gridToolbarHost, gridHost);

  body.append(rail, main);
  content.appendChild(body);

  const [rosterData, manualStore, summaries] = await Promise.all([
    loadCapabilityMatrixRoster(),
    loadManualVerdicts(),
    loadCapabilityMatrixCampaignSummaries(),
  ]);
  if (isAsyncSectionRenderStale('capability-matrix', generation)) return;

  let roster: CapabilityMatrixRosterEntry[] = rosterData.targets ?? [];

  const campaignIds = summaries.map((s) => s.id);
  const campaigns = await loadCampaignBodies(campaignIds);
  if (isAsyncSectionRenderStale('capability-matrix', generation)) return;

  let viewModel = buildCapabilityMatrixViewModel({
    roster,
    manualStore,
    campaigns,
    inFlightAutos: getCapabilityMatrixInFlightAutos(),
  });
  let latestManualStore = manualStore;
  let campaignBodies = campaigns;
  let historySummaries: BenchmarkCampaignSummary[] = summaries;
  let selectedHistoryCampaignId: string | null = null;
  let viewBannerHost: HTMLElement | null = viewBannerHostEl;

  let openSelection: { targetKey: string; capabilityId: string } | null = null;

  function campaignsForGridView(): BenchmarkCampaign[] {
    if (!selectedHistoryCampaignId) return campaignBodies;
    const match = campaignBodies.filter((row) => row.id === selectedHistoryCampaignId);
    return match.length ? match : campaignBodies;
  }

  function selectedHistoryCampaign(): BenchmarkCampaign | null {
    if (!selectedHistoryCampaignId) return null;
    return campaignBodies.find((row) => row.id === selectedHistoryCampaignId) ?? null;
  }

  function paintHistoryViewBanner(): void {
    if (!viewBannerHost) return;
    viewBannerHost.replaceChildren();
    if (!selectedHistoryCampaignId) {
      viewBannerHost.hidden = true;
      return;
    }
    const summary = historySummaries.find((row) => row.id === selectedHistoryCampaignId);
    viewBannerHost.hidden = false;
    viewBannerHost.className = 'cap-matrix-view-banner';
    viewBannerHost.setAttribute('role', 'status');

    const copy = el('p', 'cap-matrix-view-banner__text');
    copy.textContent = summary
      ? `Viewing run ${summary.id} (${summary.status})`
      : `Viewing run ${selectedHistoryCampaignId}`;

    const clearBtn = el('button', 'settings-inline-link cap-matrix-view-banner__clear', 'Show all runs');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => {
      selectedHistoryCampaignId = null;
      openSelection = null;
      closeBenchmarkTranscriptDrawer();
      rebuildViewModel();
      paintGrid();
      paintHistoryViewBanner();
      renderCapabilityMatrixHistory(historyHost, historySummaries, historyPanelOptions());
      refreshRunPanelBanners?.();
    });

    viewBannerHost.append(copy, clearBtn);
  }

  function historyPanelOptions() {
    return {
      selectedId: selectedHistoryCampaignId,
      onSelect: (summary: BenchmarkCampaignSummary | null) => {
        selectedHistoryCampaignId = summary?.id ?? null;
        openSelection = null;
        closeBenchmarkTranscriptDrawer();
        rebuildViewModel();
        paintGrid();
        paintHistoryViewBanner();
        renderCapabilityMatrixHistory(historyHost, historySummaries, historyPanelOptions());
        refreshRunPanelBanners?.();
      },
      canResume: (summary: BenchmarkCampaignSummary) => {
        if (summary.status !== 'cancelled') return false;
        const body = campaignBodies.find((row) => row.id === summary.id);
        return body ? canResumeCapabilityMatrixCampaign(body) : false;
      },
      onContinue: (summary: BenchmarkCampaignSummary) => {
        selectedHistoryCampaignId = summary.id;
        openSelection = null;
        closeBenchmarkTranscriptDrawer();
        rebuildViewModel();
        paintGrid();
        paintHistoryViewBanner();
        renderCapabilityMatrixHistory(historyHost, historySummaries, historyPanelOptions());
        refreshRunPanelBanners?.();
        const campaign = campaignBodies.find((row) => row.id === summary.id);
        if (!campaign) return;
        runDrawer.open = true;
        resumeCapabilityMatrixRunFromCampaign(campaign, {
          roster,
          viewModel,
          allowSideEffects: false,
          skipScored: true,
          groupIds: allCapabilityGroupIds(),
          probeWaves: [...CAPABILITY_MATRIX_PROBE_WAVES],
          manageModelLifecycle: false,
          onSettled: refreshView,
        });
      },
    };
  }

  function rebuildViewModel(): void {
    viewModel = buildCapabilityMatrixViewModel({
      roster,
      manualStore: latestManualStore,
      campaigns: campaignsForGridView(),
      inFlightAutos: getCapabilityMatrixInFlightAutos(),
    });
  }

  function cellTranscriptOptions() {
    return {
      campaigns: campaignsForGridView(),
      getInFlightProbeLookup: findInFlightCapabilityProbeLookup,
      getCurrentProbe: getCapabilityMatrixCurrentProbe,
      onSaved: refreshView,
    };
  }

  function refreshOpenTranscriptIfNeeded(sweepCancelled = false): void {
    if (!openSelection || !isBenchmarkTranscriptDrawerOpen()) return;
    const cell = viewModel.cellByKey.get(
      `${openSelection.targetKey}::${openSelection.capabilityId}`,
    );
    if (!cell) return;
    refreshCapabilityCellTranscript(cell, {
      ...cellTranscriptOptions(),
      targetLabel: viewModel.targetLabels[openSelection.targetKey] ?? openSelection.targetKey,
      sweepCancelled,
      onClose: () => {
        if (
          openSelection?.targetKey !== cell.targetKey ||
          openSelection.capabilityId !== cell.capabilityId
        ) {
          return;
        }
        openSelection = null;
        const openBtn = gridHost.querySelector('.cap-matrix-grid__cell.is-open');
        openBtn?.classList.remove('is-open');
        openBtn?.setAttribute('aria-pressed', 'false');
      },
    });
  }

  function paintGrid(): void {
    disposeGridNav?.();
    disposeGridNav = renderCapabilityMatrixGrid({
      host: gridHost,
      model: viewModel,
      campaigns: campaignsForGridView(),
      filter: gridFilter,
      openCell: openSelection,
      currentProbe: getCapabilityMatrixCurrentProbe(),
      getInFlightProbeLookup: findInFlightCapabilityProbeLookup,
      onSelectCell: (selection) => {
        const cell = viewModel.cellByKey.get(
          `${selection.targetKey}::${selection.capabilityId}`,
        );
        if (!cell) return;
        openSelection = selection;
        openCapabilityCellTranscript(cell, {
          ...cellTranscriptOptions(),
          targetLabel: viewModel.targetLabels[selection.targetKey] ?? selection.targetKey,
          onClose: () => {
            if (
              openSelection?.targetKey !== selection.targetKey ||
              openSelection.capabilityId !== selection.capabilityId
            ) {
              return;
            }
            openSelection = null;
            const openBtn = gridHost.querySelector('.cap-matrix-grid__cell.is-open');
            openBtn?.classList.remove('is-open');
            openBtn?.setAttribute('aria-pressed', 'false');
          },
        });
        paintGrid();
      },
    });
  }

  async function persistRoster(next: CapabilityMatrixRosterEntry[]): Promise<void> {
    roster = next;
    try {
      setStatus('spin', 'Saving roster…');
      await saveCapabilityMatrixRoster(roster);
      setStatus('ok', 'Roster saved');
    } catch (err) {
      setStatus('err', err instanceof Error ? err.message : 'Roster save failed');
    }
    await refreshView();
  }

  async function refreshView(): Promise<void> {
    if (isAsyncSectionRenderStale('capability-matrix', generation)) return;
    const [manual, history] = await Promise.all([
      loadManualVerdicts(),
      loadCapabilityMatrixCampaignSummaries(),
    ]);
    const bodies = await loadCampaignBodies(history.map((h) => h.id));
    if (isAsyncSectionRenderStale('capability-matrix', generation)) return;

    campaignBodies = bodies;
    historySummaries = history;
    latestManualStore = manual;
    if (
      selectedHistoryCampaignId &&
      !history.some((row) => row.id === selectedHistoryCampaignId)
    ) {
      selectedHistoryCampaignId = null;
    }
    rebuildViewModel();

    renderCapabilityRosterPanel({
      host: rosterHost,
      roster,
      onRosterChange: persistRoster,
    });
    paintGrid();
    renderCapabilityMatrixHistory(historyHost, historySummaries, historyPanelOptions());
    paintHistoryViewBanner();
  }

  disposeGridToolbar = mountCapabilityGridToolbar({
    host: gridToolbarHost,
    onFilterChange: (next) => {
      gridFilter = next;
      paintGrid();
    },
  });

  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    void (async () => {
      try {
        setStatus('spin', 'Importing workbook…');
        const result = await importCapabilityMatrixXlsxFile(file, roster);
        const warn =
          result.warnings.length > 0 ? ` (${result.warnings.length} warnings)` : '';
        setStatus(
          'ok',
          `Imported ${result.importedCount} manual cell${result.importedCount === 1 ? '' : 's'}${warn}`,
        );
        if (result.warnings.length > 0) {
          console.warn('[capability-matrix] import warnings', result.warnings);
        }
        await refreshView();
      } catch (err) {
        setStatus('err', err instanceof Error ? err.message : 'Import failed');
      }
    })();
  });

  const clearManualBtn = el(
    'button',
    'settings-action-btn settings-action-btn--danger',
    'Clear manual verdicts',
  );
  clearManualBtn.type = 'button';
  clearManualBtn.dataset.settingsSearchKey = 'advanced.capabilityMatrix.danger';
  clearManualBtn.addEventListener('click', () => {
    void (async () => {
      if (
        !(await appConfirm(
          'Clear all manual capability verdicts? Auto probe results in run history are kept.',
          { confirmLabel: 'Clear manual verdicts' },
        ))
      ) {
        return;
      }
      try {
        setStatus('spin', 'Clearing manual verdicts…');
        await clearManualVerdicts();
        setStatus('ok', 'Manual verdicts cleared');
        await refreshView();
      } catch (err) {
        setStatus('err', err instanceof Error ? err.message : 'Clear failed');
      }
    })();
  });

  appendSettingsDangerZone(shell, 'Danger zone', clearManualBtn, {
    searchKey: 'advanced.capabilityMatrix.danger',
  });

  await refreshView();

  disposeProbeUpdates = subscribeCapabilityMatrixProbeUpdates(() => {
    if (isAsyncSectionRenderStale('capability-matrix', generation)) return;
    rebuildViewModel();
    paintGrid();
    refreshOpenTranscriptIfNeeded();
  });

  disposeRunSubscription = subscribeCapabilityMatrixRun((state) => {
    if (isAsyncSectionRenderStale('capability-matrix', generation)) return;
    paintGrid();
    if (!state.running && state.phaseLabel === 'Cancelled') {
      refreshOpenTranscriptIfNeeded(true);
    }
  });

  disposeRunPanel = (() => {
    const panel = mountCapabilityRunPanel({
      host: runHost,
      getRoster: () => roster,
      getViewModel: () => viewModel,
      getSelectedHistoryCampaign: selectedHistoryCampaign,
      onRunSettled: refreshView,
    });
    refreshRunPanelBanners = panel.refreshBanners;
    return panel.dispose;
  })();
}
