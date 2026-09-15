import { createPickerTransport } from './element-picker';
import { getActivePreviewTabId } from '../ui/preview-tab-store';
import { getSecondaryPreviewTabId } from '../ui/preview-secondary-slot';
import { WORKSPACE_PREVIEW_SECONDARY_INSTANCE } from '../ui/right-pane-split';
import { NATIVE_DESIGN_ICON_PATHS } from './native-design-icons';

/** Mirror the controls into the native guest, which stacks above renderer DOM. */
export function mountNativeDesignStrip(instanceId: string, strip: HTMLElement): () => void {
  const transport = createPickerTransport(instanceId);
  const preview = window.minnow?.preview;
  const owner = `${Date.now()}-${Math.random()}`;
  const cleanup = `(() => { const host = document.getElementById('mn-native-design-strip'); if (host?.dataset.mnOwner === ${JSON.stringify(owner)}) host.remove(); })()`;
  let previousTab: string | undefined;
  const visitedTabs = new Set<string | undefined>();
  const remove = (tabId: string | undefined): void => {
    void (preview?.execJs ? preview.execJs(cleanup, tabId, instanceId) : transport.eval(cleanup)).catch(() => {});
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = true;
  let markup = '';
  let accent = '';
  const invalidate = (): void => { dirty = true; };
  const observer = new window.MutationObserver(invalidate);
  observer.observe(strip, { attributes: true, childList: true, subtree: true });
  observer.observe(document.documentElement, { attributes: true });
  const resizeObserver = new window.ResizeObserver(invalidate);
  resizeObserver.observe(strip);
  window.addEventListener('resize', invalidate);
  const tick = async (): Promise<void> => {
    const tabId = (instanceId === WORKSPACE_PREVIEW_SECONDARY_INSTANCE
      ? getSecondaryPreviewTabId() : getActivePreviewTabId()) ?? undefined;
    if (previousTab !== tabId) remove(previousTab);
    previousTab = tabId;
    visitedTabs.add(tabId);
    try {
      if (dirty) {
        const clone = strip.cloneNode(true) as HTMLElement;
        const originals = [strip, ...strip.querySelectorAll<HTMLElement>('*')];
        const copies = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
        originals.forEach((el, i) => {
          const css = window.getComputedStyle(el);
          for (const prop of ['display', 'flex-direction', 'align-items', 'justify-content', 'flex-wrap', 'gap', 'padding', 'margin', 'width', 'height', 'max-width', 'border', 'border-radius', 'background-color', 'color', 'font', 'box-shadow', 'cursor']) {
            copies[i]!.style.setProperty(prop, css.getPropertyValue(prop));
          }
          if (el.hidden) copies[i]!.style.display = 'none';
        });
        // Uicons render through font-backed ::before rules. Neither those rules nor the
        // font exist in the guest shadow root, so carry the same artwork as inline SVG.
        clone.querySelectorAll<HTMLElement>('.icon-svg').forEach(icon => {
          const name = Array.from(icon.classList).find(name => NATIVE_DESIGN_ICON_PATHS[name]);
          if (!name) return;
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 300 300');
          svg.setAttribute('aria-hidden', 'true');
          svg.setAttribute('focusable', 'false');
          svg.style.cssText = icon.style.cssText;
          const path = document.createElementNS(svg.namespaceURI, 'path');
          path.setAttribute('d', NATIVE_DESIGN_ICON_PATHS[name]!);
          path.setAttribute('transform', 'translate(0 300) scale(1 -1)');
          path.setAttribute('fill', 'currentColor');
          svg.appendChild(path);
          icon.replaceWith(svg);
        });
        clone.style.cssText += ';position:relative;left:auto;bottom:auto;transform:none;max-width:100%;width:max-content;height:auto';
        clone.querySelectorAll('button').forEach((button, index) => button.dataset.mnControl = String(index));
        accent = window.getComputedStyle(strip).getPropertyValue('--mn-accent').trim();
        markup = clone.outerHTML;
        dirty = false;
      }
      const script = `(() => {
        let host = document.getElementById('mn-native-design-strip');
        if (!host) {
          host = document.createElement('div');
          host.id = 'mn-native-design-strip';
          host.dataset.mnOwner = ${JSON.stringify(owner)};
          host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:50%;bottom:12px;transform:translateX(-50%);max-width:calc(100vw - 24px)';
          const root = host.attachShadow({mode:'open'});
          host.actions = [];
          root.addEventListener('click', event => {
            const button = event.target.closest('[data-mn-control]');
            if (button) { event.preventDefault(); event.stopPropagation(); host.actions.push(Number(button.dataset.mnControl)); }
          });
          document.documentElement.appendChild(host);
        }
        host.style.color = ${JSON.stringify(accent)};
        const html = ${JSON.stringify(markup)};
        if (host.markup !== html) { host.shadowRoot.innerHTML = html; host.markup = html; }
        return host.actions.splice(0);
      })()`;
      const actions = await (preview?.execJs ? preview.execJs(script, tabId, instanceId) : transport.eval(script));
      if (!stopped && Array.isArray(actions)) {
        const buttons = strip.querySelectorAll<HTMLButtonElement>('button');
        for (const index of actions) {
          if (Number.isInteger(index)) buttons[index]?.click();
          if (stopped) break;
        }
      }
    } catch {
      // Navigation temporarily removes the document. The next tick remounts the controls.
    } finally {
      if (stopped) visitedTabs.forEach(remove);
      else timer = setTimeout(() => void tick(), 150);
    }
  };
  void tick();
  return () => {
    stopped = true;
    observer.disconnect();
    resizeObserver.disconnect();
    window.removeEventListener('resize', invalidate);
    clearTimeout(timer);
    visitedTabs.forEach(remove);
  };
}
