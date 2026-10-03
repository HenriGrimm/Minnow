import { scheduleAnimationFrame } from '../lib/schedule-animation-frame';
import type { MinnowPreviewBounds } from '../electron';
import { isChromePopoverOpen, onChromePopoverChange } from './preview-electron-visibility';

export function usesElectronPreview(): boolean {
  return Boolean(window.minnow?.preview);
}

interface BoundInstance {
  element: HTMLElement;
  observer: ResizeObserver | null;
  visible: boolean;
  unsubscribePopover: () => void;
}

const boundInstances = new Map<string, BoundInstance>();

function readElementBounds(element: HTMLElement): MinnowPreviewBounds | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function syncInstance(instanceId: string): void {
  const bound = boundInstances.get(instanceId);
  const api = window.minnow?.preview;
  if (!bound || !api) return;

  if (!bound.visible || isChromePopoverOpen()) {
    void api.hide(undefined, instanceId);
    return;
  }

  const bounds = readElementBounds(bound.element);
  if (!bounds) {
    void api.hide(undefined, instanceId);
    return;
  }
  void api.show(bounds, undefined, instanceId);
}

export function bindPreviewInstanceToElement(instanceId: string, element: HTMLElement): () => void {
  unbindPreviewInstance(instanceId);

  if (!usesElectronPreview() || typeof ResizeObserver === 'undefined') {
    return () => {};
  }

  void window.minnow?.preview?.instances?.create(instanceId);

  const bound: BoundInstance = {
    element, observer: null, visible: true,
    unsubscribePopover: onChromePopoverChange(() => syncInstance(instanceId)),
  };
  boundInstances.set(instanceId, bound);

  const observer = new ResizeObserver(scheduleAnimationFrame(() => syncInstance(instanceId)));
  observer.observe(element);
  bound.observer = observer;

  syncInstance(instanceId);
  return () => unbindPreviewInstance(instanceId);
}

/** Show/hide a bound instance without unbinding it (e.g. a tab switch that hides its container). */
export function setPreviewInstanceVisible(instanceId: string, visible: boolean): void {
  const bound = boundInstances.get(instanceId);
  if (!bound) return;
  bound.visible = visible;
  syncInstance(instanceId);
}

/** Re-measure and re-apply bounds for a bound instance (e.g. after a manual layout change). */
export function syncPreviewInstanceBounds(instanceId: string): void {
  syncInstance(instanceId);
}

/** Detach a bound instance from its element and hide the native guest. Does not destroy tabs. */
export function unbindPreviewInstance(instanceId: string): void {
  const existing = boundInstances.get(instanceId);
  if (!existing) return;
  existing.observer?.disconnect();
  existing.unsubscribePopover();
  boundInstances.delete(instanceId);
  void window.minnow?.preview?.hide(undefined, instanceId);
}

/** Test helper — clear all bound instances between cases. */
export function resetPreviewInstanceHostsForTests(): void {
  for (const bound of boundInstances.values()) {
    bound.observer?.disconnect();
    bound.unsubscribePopover();
  }
  boundInstances.clear();
}
