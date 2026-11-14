import '../styles/mobile-settings.css';
import { isPairedDevice } from '../api/session-token';
import type { SettingsSectionId } from '../ui/settings-page-types';
import type { ModelsSectionId } from '../ui/models-page';
import { openSettingsPhoneList } from '../ui/settings-mobile-nav';
import { iconButton, screenHeader } from './chrome';
import { el, emptyState } from './dom';
import { getMobileWorkspaceScope, pushScreen } from './nav';
import { setMobileShellPreference } from './mode';

export type PhoneAppId = 'models' | 'brain' | 'scheduler' | 'settings';

interface PhoneAppOptions {
  settingsSection?: SettingsSectionId;
  settingsSearchKey?: string;
  allSettings?: boolean;
  modelsSection?: ModelsSectionId;
}

const APPS = {
  models: { title: 'Models', id: 'modelsView' },
  brain: { title: 'Brain', id: 'brainView' },
  scheduler: { title: 'Automations', id: 'schedulerView' },
  settings: { title: 'Settings', id: 'settingsView' },
};

/** Mount the live app into the phone stack, returning its DOM to the shell on exit. */
export function openPhoneApp(id: PhoneAppId, options: PhoneAppOptions = {}): void {
  const pairedSettings = id === 'settings' && isPairedDevice();
  if (pairedSettings) {
    const scope = getMobileWorkspaceScope();
    if (options.settingsSection === 'devices') {
      void import('./devices').then(({ openPhoneDevice }) => {
        if (scope === getMobileWorkspaceScope()) openPhoneDevice();
      });
      return;
    }
    if (!options.allSettings && !options.settingsSection && !options.settingsSearchKey) {
      void import('./settings').then(({ openPhoneSettings }) => {
        if (scope === getMobileWorkspaceScope()) openPhoneSettings();
      });
      return;
    }
  }
  const app = APPS[id];
  const detail = pairedSettings && options.settingsSection ? options.settingsSection : undefined;
  const body = el('div', { className: 'm-native-app-host' });
  const header = screenHeader({
    title: app.title,
    back: true,
    actions: id === 'settings' && !detail ? [
      iconButton('fi-rr-computer', 'Use desktop layout', () => {
        setMobileShellPreference('off');
        const url = new URL(window.location.href);
        url.searchParams.set('mobile', '0');
        window.location.replace(url);
      }),
    ] : [],
  });
  const back = header.el.querySelector<HTMLButtonElement>('.m-header__back');
  const root = el('section', { className: 'm-screen m-native-app', dataset: { screen: id } }, header.el, body);
  if (detail) root.dataset.settingsDetail = detail;
  let returnSlot: Comment | undefined;
  let page: HTMLElement | null = null;
  let request = 0;
  let closePage: (() => void) | undefined;
  let wasOsLayer = false;

  async function mount(): Promise<void> {
    const generation = ++request;
    page = document.getElementById(app.id);
    if (!page) {
      body.replaceChildren(emptyState({ glyph: 'fi-rr-info', title: `${app.title} is unavailable` }));
      return;
    }
    returnSlot = document.createComment('phone app return slot');
    page.before(returnSlot);
    body.replaceChildren(page);
    wasOsLayer = page.classList.contains('mn-os-app-layer');
    page.classList.remove('mn-os-app-layer');
    page.classList.add('m-native-app-page');
    try {
      if (id === 'models') {
        const { openModels, closeModels } = await import('../ui/models-page');
        if (generation !== request) return;
        closePage = () => closeModels({ skipNavigate: true });
        openModels(options.modelsSection ?? 'server');
        useAppHeader('.models-page-header');
      } else if (id === 'brain') {
        const { openBrain, closeBrain } = await import('../ui/brain-page');
        if (generation !== request) return;
        closePage = () => closeBrain({ skipNavigate: true });
        openBrain('graph');
      } else if (id === 'scheduler') {
        const { openScheduler, closeScheduler, initSchedulerPage } = await import('../ui/scheduler-page');
        if (generation !== request) return;
        initSchedulerPage();
        closePage = () => closeScheduler({ skipNavigate: true });
        const opening = openScheduler();
        useAppHeader('.scheduler-header');
        await opening;
      } else {
        const { openSettings, closeSettings, initSettingsPage } = await import('../ui/settings-page');
        if (generation !== request) return;
        initSettingsPage();
        closePage = () => closeSettings({ skipNavigate: true });
        const phoneList = !options.settingsSection && !options.settingsSearchKey;
        if (phoneList) openSettingsPhoneList();
        openSettings(options.settingsSection ?? 'general', {
          phoneList,
          searchKey: options.settingsSearchKey,
        });
        const title = detail && page.querySelector('.settings-area.is-active > h2')?.textContent;
        if (title) header.setTitle(title);
      }
    } catch {
      if (generation !== request) return;
      unmount();
      body.replaceChildren(emptyState({ glyph: 'fi-rr-info', title: `Could not open ${app.title}` }));
    }
  }

  function useAppHeader(selector: string): void {
    const appHeader = page?.querySelector(selector);
    if (!back || !appHeader) return;
    appHeader.prepend(back);
    root.classList.add('m-native-app--inline-header');
  }

  function unmount(): void {
    ++request;
    closePage?.();
    closePage = undefined;
    if (page) {
      if (back) header.el.prepend(back);
      root.classList.remove('m-native-app--inline-header');
      page.classList.remove('m-native-app-page');
      page.classList.toggle('mn-os-app-layer', wasOsLayer);
      returnSlot?.replaceWith(page);
    }
    page = null;
    returnSlot = undefined;
  }

  pushScreen({
    key: `app:${id}:${options.settingsSection ?? options.modelsSection ?? ''}:${options.settingsSearchKey ?? ''}`,
    el: root,
    onShow: () => { if (!page) void mount(); },
    onHide: unmount,
    dispose: unmount,
  });
}
