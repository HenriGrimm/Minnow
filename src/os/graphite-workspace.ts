import '../styles/graphite-workspace.css';
import { registerCommandSource } from '../ui/command-registry';
import { createIcon } from '../ui/icon';
import { CHAT_SIDEBAR_CHANGED_EVENT } from '../ui/layout-events';
import { isNarrowLayout, NARROW_MQ } from '../ui/mobile-layout';
import { buildMenuItems, openRegisteredMenu } from '../ui/menu-registry';
import { closeWorkspaceMenu } from '../ui/workspace-recent-menu';
import { subscribeModelInventory } from '../models/inventory-events';
import type { ServeActivity } from '../models/api-client';
import { subscribeServeActivityFeed } from '../models/serve-activity-feed';
import { getOsView, subscribeInstances } from './instances';
import { launchApp, navigateToCodeChat, navigateToCodeDevServers, navigateToCodeMap, navigateToCodeOrchestrate } from './router';
import { syncWorkspaceMenubarPlacement } from './workspace-menubar';

function move(element: HTMLElement, target: HTMLElement, before: Element | null = null): void {
  if (element.parentElement !== target) target.insertBefore(element, before);
}

/** Keep the same thread list and actions when apps change or the viewport crosses the drawer breakpoint. */
export function initGraphiteWorkspace(rail: HTMLElement, menubar: HTMLElement): () => void {
  const html = document.documentElement;
  const body = document.getElementById('appBody');
  const sidebar = document.getElementById('chatSidebar');
  const nav = rail.querySelector<HTMLElement>('.mn-os-app-rail__nav');
  if (!body || !sidebar || !nav) return () => {};

  const workspaceSlot = document.createElement('div');
  workspaceSlot.id = 'osGraphiteWorkspaceSlot';
  workspaceSlot.className = 'mn-graphite-workspace-slot';
  workspaceSlot.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'mn-graphite-thread-actions';
  actions.hidden = true;
  const create = document.createElement('button');
  create.className = 'mn-graphite-thread-new';
  create.type = 'button';
  create.append(createIcon('edit', { size: 14 }));
  const label = document.createElement('span');
  label.textContent = 'New thread';
  const shortcut = document.createElement('kbd');
  shortcut.textContent = /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘N' : 'Ctrl+N';
  shortcut.setAttribute('aria-hidden', 'true');
  create.append(label, shortcut);
  create.addEventListener('click', () => {
    void import('../ui/sidebar').then(({ createChat }) => createChat());
  });
  actions.appendChild(create);

  const search = menubar.querySelector<HTMLElement>('.mn-os-mb-search');
  const menubarActions = menubar.querySelector<HTMLElement>('.mn-os-mb-right');
  const workspaceActions = menubar.querySelector<HTMLElement>('.mn-os-workspace-actions');
  const modelsTrigger = workspaceActions?.querySelector<HTMLButtonElement>('[aria-controls="modelsSystemPopover"]');

  const modelCard = document.createElement('button');
  modelCard.type = 'button';
  modelCard.className = 'mn-graphite-local-model';
  modelCard.hidden = true;
  const modelTitle = document.createElement('span');
  modelTitle.className = 'mn-graphite-local-model__title';
  const modelDetail = document.createElement('span');
  modelDetail.className = 'mn-graphite-local-model__detail';
  const modelDot = document.createElement('span');
  modelDot.className = 'mn-graphite-local-model__dot';
  modelDot.setAttribute('aria-hidden', 'true');
  const modelCopy = document.createElement('span');
  modelCopy.className = 'mn-graphite-local-model__copy';
  modelCopy.append(modelTitle, modelDetail);
  const modelLink = createIcon('chevronRight', { size: 14 });
  const modelRate = document.createElement('span');
  modelRate.className = 'mn-graphite-local-model__rate';
  modelRate.hidden = true;
  const spark = document.createElement('span');
  spark.className = 'mn-graphite-local-model__spark';
  spark.setAttribute('aria-hidden', 'true');
  spark.hidden = true;
  modelCard.append(modelDot, modelCopy, modelLink, modelRate, spark);
  modelCard.addEventListener('click', () => launchApp('models', { modelsSection: 'server' }));

  const auxiliary = document.createElement('div');
  auxiliary.className = 'mn-graphite-auxiliary';
  const footer = document.createElement('div');
  footer.className = 'mn-graphite-sidebar-footer';
  footer.id = 'osGraphiteSidebarFooter';
  auxiliary.append(modelCard, footer);
  rail.insertBefore(workspaceSlot, nav);
  rail.insertBefore(actions, nav);
  rail.appendChild(auxiliary);

  let desktop = false;
  let sidebarShown = false;
  let modelRequest: AbortController | null = null;
  let serveId: string | undefined;
  let stopModelActivity: (() => void) | undefined;
  let lastSample = 0;
  const samples: number[] = [];
  const setTrackedModel = (id: string | undefined): void => {
    if (serveId === id) return;
    stopModelActivity?.();
    stopModelActivity = undefined;
    serveId = id;
    lastSample = 0;
    samples.length = 0;
    spark.hidden = modelRate.hidden = true;
    modelLink.removeAttribute('hidden');
    spark.replaceChildren();
    if (id) stopModelActivity = subscribeServeActivityFeed(paintModelActivity);
  };
  function paintModelActivity(activity: ServeActivity): void {
    if (activity.serveId !== serveId || activity.updatedAt <= lastSample) return;
    lastSample = activity.updatedAt;
    const rate = activity.mtplx?.latest?.decode_tok_s
      ?? activity.slots.find(slot => slot.state === 'generating')?.tokensPerSecond;
    if (!activity.available || activity.stale || rate == null || !Number.isFinite(rate) || rate <= 0) {
      modelDetail.textContent = 'Ready';
      modelRate.hidden = true;
      modelLink.removeAttribute('hidden');
      return;
    }
    modelDetail.textContent = 'Generating';
    modelRate.textContent = `${Math.round(rate)} tok/s`;
    modelRate.hidden = false;
    modelLink.setAttribute('hidden', '');
    samples.push(rate);
    if (samples.length > 18) samples.shift();
    const peak = Math.max(...samples);
    spark.replaceChildren(...samples.map(sample => {
      const bar = document.createElement('span');
      bar.style.height = `${Math.max(12, sample / peak * 100)}%`;
      return bar;
    }));
    spark.hidden = false;
  }
  const refreshModel = async () => {
    if (!sidebarShown || document.hidden || modelRequest) return;
    const controller = new AbortController();
    modelRequest = controller;
    try {
      const { listModelServes } = await import('../models/api-client');
      const rows = await listModelServes(AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
      if (controller.signal.aborted || !sidebarShown) return;
      const running = rows.find((row) => row.status === 'running');
      const starting = rows.find((row) => row.status === 'starting');
      const unhealthy = rows.find((row) => row.status === 'unhealthy');
      const serve = running ?? starting ?? unhealthy;
      modelCard.hidden = !serve;
      if (!serve) {
        setTrackedModel(undefined);
        return;
      }
      modelCard.dataset.state = serve.status;
      modelTitle.textContent = serve.modelLabel || 'Local model';
      if (!running || serveId !== running.id) modelDetail.textContent = running ? 'Ready' : starting ? 'Loading model…' : 'Runtime unhealthy';
      setTrackedModel(running?.id);
    } catch {
      if (!controller.signal.aborted && !modelCard.hidden) {
        setTrackedModel(undefined);
        modelCard.dataset.state = 'unavailable';
        modelTitle.textContent = 'Local server unavailable';
        modelDetail.textContent = 'Open Models';
      }
    } finally {
      if (modelRequest === controller) modelRequest = null;
    }
  };
  const unregisterCommands = registerCommandSource('graphite-code-views', () => [
    { id: 'graphite-code-chat', title: 'Open Code chats', group: 'Code', keywords: 'threads conversations', run: navigateToCodeChat },
    { id: 'graphite-code-servers', title: 'Open Dev servers', group: 'Code', keywords: 'preview ports local server', run: navigateToCodeDevServers },
    { id: 'graphite-code-map', title: 'Open Code map', group: 'Code', keywords: 'workspace architecture graph', run: navigateToCodeMap },
    { id: 'graphite-code-orchestrate', title: 'Open Orchestrate', group: 'Code', keywords: 'board plan agents', run: navigateToCodeOrchestrate },
    {
      id: 'graphite-model-quick-controls',
      title: 'Quick model controls',
      group: 'Models',
      available: () => sidebarShown,
      run: () => modelsTrigger?.click(),
    },
    {
      id: 'graphite-workspace-wiki',
      title: 'Open Minnow wiki',
      group: 'Workspace',
      keywords: 'help documentation user manual',
      run: async () => {
        const { openProductWiki } = await import('../ui/product-wiki');
        openProductWiki();
      },
    },
    {
      id: 'graphite-workspace-plugins',
      title: 'Plugin commands',
      group: 'Workspace',
      available: () => sidebarShown && buildMenuItems({ kind: 'menubar.plugins' }).length > 0,
      run: () => {
        if (search) openRegisteredMenu({ target: { kind: 'menubar.plugins' }, label: 'Plugin commands', anchor: search, restoreFocus: search });
      },
    },
  ]);
  const sync = (): void => {
    const nextDesktop = !isNarrowLayout();
    const nextShown = nextDesktop && getOsView() === 'app' &&
      !sidebar.classList.contains('collapsed') && !html.classList.contains('os-workspace-gate-open');
    const desktopChanged = nextDesktop !== desktop;
    const visibilityChanged = nextShown !== sidebarShown;
    if (desktopChanged || visibilityChanged) closeWorkspaceMenu();
    desktop = nextDesktop;
    sidebarShown = nextShown;
    html.classList.toggle('mn-graphite-workspace', desktop);
    html.classList.toggle('mn-graphite-sidebar-open', sidebarShown);
    workspaceSlot.hidden = !sidebarShown;
    actions.hidden = !sidebarShown;
    auxiliary.hidden = !sidebarShown;
    if (desktop) move(sidebar, rail, auxiliary);
    else move(sidebar, body, body.firstElementChild);
    const threadViews = document.getElementById('chatListViews');
    if (threadViews) {
      const target = sidebarShown ? footer : document.getElementById('chatSidebarMain');
      if (target) move(threadViews, target, sidebarShown ? target.firstElementChild : null);
    }
    if (workspaceActions && menubarActions) {
      const focused = document.activeElement;
      move(workspaceActions, sidebarShown ? footer : menubarActions);
      if (focused instanceof HTMLElement && workspaceActions.contains(focused) && document.activeElement !== focused) {
        focused.focus({ preventScroll: true });
      }
    }
    syncWorkspaceMenubarPlacement();
    if (desktopChanged || visibilityChanged) window.dispatchEvent(new window.Event('minnow:graphite-workspace-changed'));
    if (visibilityChanged && sidebarShown) void refreshModel();
    if (!sidebarShown) {
      modelRequest?.abort();
      setTrackedModel(undefined);
    }
  };

  const breakpoint = window.matchMedia?.(NARROW_MQ);
  breakpoint?.addEventListener?.('change', sync);
  window.addEventListener(CHAT_SIDEBAR_CHANGED_EVENT, sync);
  window.addEventListener('minnow:workspace-gate-changed', sync);
  const onModelRefresh = () => { void refreshModel(); };
  window.addEventListener('focus', onModelRefresh);
  document.addEventListener('visibilitychange', onModelRefresh);
  const unsubscribeModelInventory = subscribeModelInventory(onModelRefresh);
  const modelTimer = window.setInterval(onModelRefresh, 10_000);
  const unsubscribe = subscribeInstances(sync);
  sync();

  return () => {
    unsubscribe();
    breakpoint?.removeEventListener?.('change', sync);
    window.removeEventListener(CHAT_SIDEBAR_CHANGED_EVENT, sync);
    window.removeEventListener('minnow:workspace-gate-changed', sync);
    window.removeEventListener('focus', onModelRefresh);
    document.removeEventListener('visibilitychange', onModelRefresh);
    window.clearInterval(modelTimer);
    unsubscribeModelInventory();
    unregisterCommands();
    modelRequest?.abort();
    setTrackedModel(undefined);
    html.classList.remove('mn-graphite-workspace', 'mn-graphite-sidebar-open');
    move(sidebar, body, body.firstElementChild);
    const threadViews = document.getElementById('chatListViews');
    const sidebarMain = document.getElementById('chatSidebarMain');
    if (threadViews && sidebarMain) move(threadViews, sidebarMain);
    if (workspaceActions && menubarActions) move(workspaceActions, menubarActions);
    syncWorkspaceMenubarPlacement();
    workspaceSlot.remove();
    actions.remove();
    auxiliary.remove();
  };
}
