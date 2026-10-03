import { mountPluginDom, type PluginDomRender, type PluginMountPosition } from './dom';
import { getPluginChatUsage, getPluginWorkspaceUsage, subscribePluginChatUsage, type PluginChatUsage } from './usage';
import { registerPluginApp } from '../os/app-registry';
import { getInstanceSnapshot, closeInstance } from '../os/instances';
import { registerMenuContributor, openRegisteredMenu, type MenuContributor, type MenuContributorOptions } from '../ui/menu-registry';
import { closeContextMenu, type MenuItem } from '../ui/context-menu';
import { registerCommandSource, type Command } from '../ui/command-registry';
import { executeTool } from '../tools/client';
import { createAppIcon, type OsIconName } from '../os/icons';
import type { PluginAppId } from '../os/types';

export interface PluginAppOptions {
  id: string;
  name: string;
  description?: string;
  icon?: OsIconName;
}

/** Trusted UI API. Direct document access is also available to the module. */
export function createPluginUiContext(pluginId: string, release: string, tools: string[]) {
  const controller = new AbortController();
  const cleanups = new Set<() => void>();
  const ids = new Set<string>();
  const assertActive = () => {
    if (controller.signal.aborted) throw new Error('Plugin UI is no longer active');
  };
  function own(cleanup: () => void): () => void {
    if (controller.signal.aborted) { cleanup(); return () => {}; }
    const dispose = () => { cleanups.delete(dispose); cleanup(); };
    cleanups.add(dispose);
    return dispose;
  }
  function contributionId(kind: string, id: string): string {
    assertActive();
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(id)) throw new Error('Contribution id must be snake_case, at most 24 characters');
    const key = `plugin-${pluginId}:${kind}:${id}`;
    if (ids.has(key)) throw new Error('Duplicate plugin contribution id');
    ids.add(key);
    own(() => { ids.delete(key); });
    return key;
  }
  function guardItems(items: MenuItem[]): MenuItem[] {
    return items.map(item => {
      if (item.kind === 'submenu') {
        const children = item.items;
        return { ...item, items: () => controller.signal.aborted ? [] : guardItems(typeof children === 'function' ? children() : children) };
      }
      if (item.kind === 'heading' || item.kind === 'separator') return { ...item };
      return { ...item, onSelect: () => { assertActive(); return item.onSelect(); } };
    });
  }
  const context = {
    pluginId,
    signal: controller.signal,
    onCleanup: own,
    mount(selector: string, render: PluginDomRender, position?: PluginMountPosition) {
      assertActive();
      return own(mountPluginDom(selector, render, position));
    },
    getChatUsage: getPluginChatUsage,
    getWorkspaceUsage: getPluginWorkspaceUsage,
    onChatUsage(listener: (usage: PluginChatUsage) => void, chatId?: string) {
      assertActive();
      return own(subscribePluginChatUsage(listener, chatId));
    },
    async callTool(tool: string, args: Record<string, unknown> = {}) {
      assertActive();
      if (!tools.includes(tool)) throw new Error('UI can call only its plugin’s declared tools');
      const response = await fetch(`/api/plugins/packages/${pluginId}/ui/${release}`, { signal: controller.signal });
      if (!response.ok || (await response.json()).release !== release) throw new Error('Plugin changed; refresh its UI');
      const result = await executeTool(`plugin__${pluginId.replace(/-/g, '_')}__${tool}`, args, {
        modeId: 'general', signal: controller.signal, pluginRelease: release,
      });
      return result.content;
    },
    registerMenu(id: string, contribute: MenuContributor, options?: MenuContributorOptions) {
      const key = contributionId('menu', id);
      return own(registerMenuContributor(key, target => controller.signal.aborted ? null : guardItems(contribute(target) ?? []), options));
    },
    openMenu(options: Parameters<typeof openRegisteredMenu>[0]) {
      assertActive();
      const handle = openRegisteredMenu({ ...options, items: guardItems(options.items ?? []) });
      own(handle.close);
      return handle;
    },
    registerCommand(command: Command) {
      const key = contributionId('command', command.id);
      return own(registerCommandSource(key, () => controller.signal.aborted ? [] : [{
        ...command, id: key, run: () => { assertActive(); return command.run(); },
      }]));
    },
    registerApp(options: PluginAppOptions, mount: (root: HTMLElement) => void | (() => void) | Promise<void | (() => void)>) {
      contributionId('app', options.id);
      if (!options.name?.trim() || options.name.length > 100) throw new Error('App name must be nonempty, at most 100 characters');
      // Validate icon names before adding a tile to the rail.
      createAppIcon(options.icon ?? 'grid');
      const appId: PluginAppId = `plugin-${pluginId}--${options.id}`;
      const root = document.createElement('section');
      root.id = `osAppLayer-${appId}`;
      root.className = 'mn-os-app-layer plugin-app';
      root.dataset.osApp = appId;
      root.setAttribute('aria-label', options.name);
      const appsLayer = document.getElementById('osAppsLayer');
      if (!appsLayer) throw new Error('App shell is not available');
      appsLayer.append(root);
      let mounting: Promise<void> | undefined;
      const unregister = registerPluginApp({
        id: appId, name: options.name, icon: options.icon ?? 'grid',
        tag: options.description ?? '', description: options.description ?? '',
        availability: 'optional', releaseState: 'released',
        open: () => {
          assertActive();
          return mounting ??= Promise.resolve().then(() => {
            assertActive();
            return mount(root);
          }).then(cleanup => { if (typeof cleanup === 'function') own(cleanup); }).catch(error => {
            mounting = undefined;
            throw error;
          });
        },
      });
      own(() => {
        // Close while metadata still exists so navigation can return to another app.
        for (const instance of getInstanceSnapshot().instances) {
          if (instance.appId === appId) closeInstance(instance.id);
        }
        unregister();
        root.remove();
      });
      return {
        id: appId,
        async launch() { assertActive(); (await import('../os/router')).launchApp(appId); },
      };
    },
  };
  return {
    context: Object.freeze(context),
    dispose() {
      if (controller.signal.aborted) return;
      controller.abort();
      // Menu callbacks captured before revocation must not remain actionable.
      closeContextMenu();
      for (const cleanup of [...cleanups].reverse()) {
        try { cleanup(); } catch (error) { console.error(`[plugin-ui] ${pluginId} cleanup failed`, error); }
      }
      cleanups.clear();
    },
  };
}

export type PluginUiContext = ReturnType<typeof createPluginUiContext>['context'];
