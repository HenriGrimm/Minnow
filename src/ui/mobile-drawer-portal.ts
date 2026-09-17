type DrawerKind = 'chat' | 'file';

const SIDEBAR_IDS: Record<DrawerKind, string> = {
  chat: 'chatSidebar',
  file: 'fileSidebar',
};

const HTML_CLASS: Record<DrawerKind, string> = {
  chat: 'mn-os-mobile-chat-drawer',
  file: 'mn-os-mobile-file-drawer',
};

const BACKDROP_IDS = ['sidebarBackdrop', 'fileSidebarBackdrop'] as const;

function restoreSidebarHome(sidebarId: string, placement: 'prepend' | 'append'): void {
  const appBody = document.getElementById('appBody');
  const side = document.getElementById(sidebarId);
  if (!appBody || !side || side.parentElement === appBody) return;
  // Issues borrows the file sidebar as its own drawer (issues-file-drawer.ts) and
  // restores it on close; pulling it back here hides it inside the inactive Code layer.
  if (side.classList.contains('file-sidebar--issues-drawer')) return;
  if (placement === 'prepend') {
    appBody.insertBefore(side, appBody.firstChild);
  } else {
    appBody.appendChild(side);
  }
  delete side.dataset.osMobilePortal;
}

/** Undo legacy portal-to-root attempts from earlier fixes. */
function restoreLegacyPortaledSidebars(): void {
  restoreSidebarHome('chatSidebar', 'prepend');
  restoreSidebarHome('fileSidebar', 'append');
}

/** Sync shell class used by minnowos-shell.css overflow + drawer geometry. */
export function syncOsMobileDrawerHtmlClass(kind: DrawerKind, open: boolean): void {
  document.documentElement.classList.toggle(HTML_CLASS[kind], open);
}

/** Reparent mobile drawer scrims into #appBody and fix stale sidebar DOM. */
export function mountOsMobileDrawerBackdrops(): void {
  restoreLegacyPortaledSidebars();

  const appBody = document.getElementById('appBody');
  if (!appBody) return;

  for (const id of BACKDROP_IDS) {
    const el = document.getElementById(id);
    if (el && el.parentElement !== appBody) {
      appBody.insertBefore(el, appBody.firstChild);
    }
  }
}
