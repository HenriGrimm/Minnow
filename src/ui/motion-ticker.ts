import { isRenderIdle, subscribeRenderIdle } from '../boot/render-idle';

/** Set on `<html>` while stepping. Carries no CSS — it is a state flag for diagnostics. */
const MOTION_ATTR = 'data-mn-motion';
const MOTION_TICKED = 'ticked';

/** Smooth local-generation feedback without asking the compositor for a frame every vsync. */
const STEP_HZ = 30;
const STEP_INTERVAL_MS = Math.round(1000 / STEP_HZ);

/** Ceiling on a single advance. */
const MAX_STEP_MS = 250;

/** The slice of the Web Animations API this module needs, structurally typed so tests can drive it without a DOM that implements animations. */
export interface SteppableAnimation {
  readonly playState: string;
  currentTime: number | null;
  readonly effect: { getTiming(): { iterations?: number } } | null;
  pause(): void;
  play(): void;
}

const NOOP = (): void => {};

let leases = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let lastStepAt = 0;
let unwatchIdle: (() => void) | undefined;
const parked = new Set<SteppableAnimation>();

/** Only looping animations are worth parking; a finite one ends on its own. */
function isInfinite(anim: SteppableAnimation): boolean {
  return anim.effect?.getTiming().iterations === Infinity;
}

/** Pause every running infinite animation and take ownership of stepping it. */
export function parkRunningInfinite(
  animations: Iterable<SteppableAnimation>,
  into: Set<SteppableAnimation> = parked,
): void {
  for (const anim of animations) {
    if (anim.playState !== 'running' || into.has(anim)) continue;
    if (!isInfinite(anim)) continue;
    anim.pause();
    into.add(anim);
  }
}

/** Advance every parked animation by one tick, dropping any that has since been cancelled. */
export function stepParked(deltaMs: number, from: Set<SteppableAnimation> = parked): void {
  for (const anim of [...from]) {
    if (anim.playState === 'idle') {
      from.delete(anim);
      continue;
    }
    const at = anim.currentTime;
    if (typeof at !== 'number') continue;
    anim.currentTime = at + deltaMs;
  }
}

/** Hand the animations back to the compositor at full rate. */
export function resumeParked(from: Set<SteppableAnimation> = parked): void {
  for (const anim of from) {
    if (anim.playState !== 'paused') continue;
    anim.play();
  }
  from.clear();
}

type AnimationsHost = {
  getAnimations?: (opts?: { subtree?: boolean }) => Iterable<unknown> | unknown[];
};

/** Read WAAPI animations from a node without assuming a real CSSAnimation type. */
function readAnimations(target: AnimationsHost, subtree: boolean): SteppableAnimation[] {
  if (typeof target.getAnimations !== 'function') return [];
  try {
    const raw = subtree ? target.getAnimations({ subtree: true }) : target.getAnimations();
    if (!raw || typeof (raw as Iterable<unknown>)[Symbol.iterator] !== 'function') return [];
    return [...(raw as Iterable<SteppableAnimation>)];
  } catch {
    return [];
  }
}

function currentAnimations(): SteppableAnimation[] {
  if (typeof document === 'undefined') return [];
  return readAnimations(document as unknown as AnimationsHost, false);
}

function parkTarget(target: AnimationsHost, subtree: boolean): void {
  parkRunningInfinite(readAnimations(target, subtree));
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Class-toggled loops on already-mounted chrome (sidebar dots) never appear as childList mutations. */
function onAnimationStarted(ev: Event): void {
  const target = ev.target;
  if (!target || typeof (target as AnimationsHost).getAnimations !== 'function') return;
  parkTarget(target as AnimationsHost, false);
}

function startDiscovery(): void {
  // animationstart covers inserted spinners and class changes after browser style resolution.
  // Inspecting getAnimations on every Markdown mutation forced unrelated layout during streams.
  document.addEventListener('animationstart', onAnimationStarted, true);
  unwatchIdle = subscribeRenderIdle(idle => {
    if (!idle) parkRunningInfinite(currentAnimations());
  });
}

function stopDiscovery(): void {
  unwatchIdle?.(); unwatchIdle = undefined;
  if (typeof document !== 'undefined') document.removeEventListener('animationstart', onAnimationStarted, true);
}

function tick(): void {
  const at = now();
  if (isRenderIdle()) {
    lastStepAt = at;
    return;
  }

  stepParked(Math.min(at - lastStepAt, MAX_STEP_MS));
  lastStepAt = at;
}

function start(): void {
  document.documentElement?.setAttribute(MOTION_ATTR, MOTION_TICKED);
  lastStepAt = now();
  parkRunningInfinite(currentAnimations());
  startDiscovery();
  timer = setInterval(tick, STEP_INTERVAL_MS);
}

function stop(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  stopDiscovery();
  document.documentElement?.removeAttribute(MOTION_ATTR);
  resumeParked();
}

/** True while looping animations are being stepped rather than run at the refresh rate. */
export function isTickedMotionActive(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement?.getAttribute(MOTION_ATTR) === MOTION_TICKED;
}

/** Step looping animations at STEP_HZ (30 Hz) until the returned function is called. */
export function acquireTickedMotion(): () => void {
  if (typeof document === 'undefined') return NOOP;
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return NOOP;
  }

  leases += 1;
  if (leases === 1) start();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    leases = Math.max(0, leases - 1);
    if (leases === 0) stop();
  };
}
