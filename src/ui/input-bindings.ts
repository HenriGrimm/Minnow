/** Input translation at the window capture boundary preserves existing view/keymap precedence. */
export type KeyInput = { kind: 'key'; key: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean };
export type ShortcutInput = KeyInput
  | { kind: 'mouse'; button: number; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }
  | { kind: 'wheel'; direction: 'up' | 'down'; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }
  | { kind: 'gamepad'; control: 'button' | 'axis'; index: number; direction: -1 | 1 };
export interface InputBinding { target: KeyInput; input: ShortcutInput | null; inText: boolean }
export const INPUT_BINDINGS_KEY = 'minnow.input-bindings.v1';
const modifiers = ['ctrl', 'meta', 'alt', 'shift'] as const;
export function keyInput(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): KeyInput {
  return { kind: 'key', key: event.key.length === 1 ? event.key.toLowerCase() : event.key,
    ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey };
}
export function inputId(input: ShortcutInput): string {
  if (input.kind === 'gamepad') return `gamepad:${input.control}:${input.index}:${input.direction}`;
  const value = input.kind === 'key' ? input.key : input.kind === 'mouse' ? input.button : input.direction;
  return `${input.kind}:${modifiers.map((m) => input[m] ? '1' : '0').join('')}:${value}`;
}
export function inputLabel(input: ShortcutInput | null): string {
  if (!input) return 'Disabled';
  if (input.kind === 'gamepad') return `Gamepad ${input.control} ${input.index}${input.control === 'axis' ? (input.direction > 0 ? ' +' : ' −') : ''}`;
  const value = input.kind === 'key' ? (input.key === ' ' ? 'Space' : input.key.length === 1 ? input.key.toUpperCase() : input.key)
    : input.kind === 'mouse' ? `Mouse ${input.button + 1}` : `Wheel ${input.direction}`;
  return [...modifiers.filter((m) => input[m]).map((m) => ({ ctrl: 'Ctrl', meta: 'Cmd', alt: 'Alt', shift: 'Shift' })[m]), value].join(' + ');
}
function validInput(raw: unknown): raw is ShortcutInput {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'gamepad') return (r.control === 'button' || r.control === 'axis') && Number.isInteger(r.index) && Number(r.index) >= 0 && Number(r.index) < 128 && (r.direction === 1 || r.direction === -1) && (r.control !== 'button' || r.direction === 1);
  if (!modifiers.every((m) => typeof r[m] === 'boolean')) return false;
  return r.kind === 'key' ? typeof r.key === 'string' && r.key.length > 0 && r.key.length < 64 && !['Control', 'Meta', 'Alt', 'Shift', 'Dead', 'Unidentified', 'Process'].includes(r.key)
    : r.kind === 'mouse' ? Number.isInteger(r.button) && Number(r.button) >= 0 && Number(r.button) < 32
      : r.kind === 'wheel' && (r.direction === 'up' || r.direction === 'down');
}
export function parseBindings(raw: string | null): InputBinding[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > 512) throw new Error('Invalid shortcut preferences. Reset shortcuts to recover.');
  const targets = new Set<string>();
  const inputs = new Set<string>();
  return parsed.map((r: InputBinding) => {
    if (!r || !validInput(r.target) || r.target.kind !== 'key' || (r.input !== null && !validInput(r.input)) || typeof r.inText !== 'boolean') throw new Error('Invalid shortcut binding.');
    const target = inputId(r.target);
    const input = r.input && inputId(r.input);
    if (targets.has(target) || (input && inputs.has(input))) throw new Error('Duplicate shortcut binding.');
    targets.add(target);
    if (input) inputs.add(input);
    return { target: r.target, input: r.input, inText: r.inText };
  });
}
export class InputBindingStore {
  bindings: InputBinding[] = [];
  error = '';
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'>) { this.reload(); }
  reload(): void {
    try { this.bindings = parseBindings(this.storage.getItem(INPUT_BINDINGS_KEY)); this.error = ''; }
    catch (error) { this.error = String(error); this.bindings = []; }
  }
  save(next: InputBinding[]): void {
    const text = JSON.stringify(next);
    const validated = parseBindings(text);
    this.storage.setItem(INPUT_BINDINGS_KEY, text); // Publish only after durable write succeeds.
    this.bindings = validated;
    this.error = '';
  }
}
let store: InputBindingStore | undefined;
export function getInputBindingStore(): InputBindingStore {
  return store ??= new InputBindingStore(window.localStorage);
}
export function resolveInput(bindings: InputBinding[], input: ShortcutInput, inText: boolean): KeyInput | null | undefined {
  const id = inputId(input);
  const match = bindings.find((r) => r.input && inputId(r.input) === id);
  if (match && (!inText || match.inText || (input.kind !== 'gamepad' && (input.ctrl || input.meta || input.alt)))) return match.target;
  if (input.kind === 'key' && bindings.some((r) => inputId(r.target) === id && (!r.input || inputId(r.input) !== id)
    && (!inText || r.inText || input.ctrl || input.meta || input.alt))) return null;
  return undefined;
}
type Recorder = (input: ShortcutInput) => void;
let recorder: Recorder | undefined;
let paused = 0;
export async function withInputBindingsPaused<T>(action: () => Promise<T>): Promise<T> {
  paused++;
  try { return await action(); } finally { paused--; }
}
export function recordShortcut(callback?: Recorder): void { recorder = callback; }
function typing(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, [contenteditable="true"], .cm-editor, .xterm');
}
function codeFor(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return ({ ' ': 'Space', '`': 'Backquote', '.': 'Period', '/': 'Slash', '?': 'Slash', ',': 'Comma', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal' } as Record<string, string>)[key] ?? key;
}
export function dispatchShortcut(target: EventTarget, key: KeyInput, type = 'keydown', repeat = false): void {
  const event = new KeyboardEvent(type, { key: key.shift && key.key.length === 1 ? key.key.toUpperCase() : key.key,
    code: codeFor(key.key), ctrlKey: key.ctrl, metaKey: key.meta, altKey: key.alt, shiftKey: key.shift,
    bubbles: true, composed: true, cancelable: true, repeat });
  translated.add(event);
  target.dispatchEvent(event);
}
const translated = new WeakSet<Event>();
/** Edge-trigger controls with hysteresis; held buttons/sticks never repeat actions. */
export function gamepadEdges(pads: readonly (Gamepad | null)[], held: Set<string>): ShortcutInput[] {
  const next = new Set<string>();
  const edges: ShortcutInput[] = [];
  for (const pad of pads) {
    if (!pad) continue;
    const visit = (control: 'button' | 'axis', index: number, direction: -1 | 1, value: number) => {
      const id = `${pad.index}:${control}:${index}:${direction}`;
      if (value < (held.has(id) ? 0.4 : 0.7)) return;
      next.add(id);
      if (!held.has(id)) edges.push({ kind: 'gamepad', control, index, direction });
    };
    pad.buttons.forEach((button, i) => visit('button', i, 1, button.value));
    pad.axes.forEach((axis, i) => { visit('axis', i, 1, axis); visit('axis', i, -1, -axis); });
  }
  held.clear(); next.forEach((id) => held.add(id));
  return edges;
}
export function installInputBindings(): () => void {
  const preferences = getInputBindingStore();
  const held = new Set<string>();
  const consumedButtons = new Set<number>();
  const activeKeys = new Map<string, KeyInput | null>();
  let gamepadTimer: ReturnType<typeof setInterval> | undefined;
  const apply = (input: ShortcutInput, event?: Event): boolean => {
    if (paused) return false;
    const source = event?.target ?? document.activeElement ?? document.body;
    const target = event instanceof KeyboardEvent ? source : document.activeElement ?? document.body;
    if (recorder && source instanceof Element && source.closest('[data-shortcut-recording-control]') && input.kind === 'mouse') return false;
    if (recorder) {
      event?.preventDefault(); event?.stopImmediatePropagation(); recorder(input); return true;
    }
    // Keep the recovery UI usable even after assigning primary mouse buttons or navigation keys.
    if (source instanceof Element && source.closest('.shortcut-settings, .xterm')) return false;
    if (target instanceof Element && target.closest('.shortcut-settings, .xterm')) return false;
    const result = resolveInput(preferences.bindings, input, typing(target));
    if (result === undefined) return false;
    event?.preventDefault(); event?.stopImmediatePropagation();
    if (result) {
      dispatchShortcut(target, result, 'keydown', event instanceof KeyboardEvent && event.repeat);
      if (event instanceof KeyboardEvent) activeKeys.set(event.code || event.key, result);
      else dispatchShortcut(target, result, 'keyup');
    } else if (event instanceof KeyboardEvent) activeKeys.set(event.code || event.key, null);
    return true;
  };
  const keyboard = (event: KeyboardEvent) => {
    if (translated.has(event) || event.isComposing || event.keyCode === 229) return;
    if (event.type === 'keyup') {
      const id = event.code || event.key;
      if (!activeKeys.has(id)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const result = activeKeys.get(id);
      activeKeys.delete(id);
      if (result) dispatchShortcut(event.target ?? document.body, result, 'keyup');
      return;
    }
    if (['Control', 'Meta', 'Alt', 'Shift', 'Dead', 'Unidentified', 'Process'].includes(event.key)) return;
    apply(keyInput(event), event);
  };
  const pointer = (event: PointerEvent) => {
    const input: ShortcutInput = { kind: 'mouse', button: event.button, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey };
    if (apply(input, event)) consumedButtons.add(event.button);
  };
  const click = (event: MouseEvent) => {
    if (!consumedButtons.has(event.button)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type !== 'contextmenu') consumedButtons.delete(event.button);
  };
  const wheel = (event: WheelEvent) => {
    if (!event.deltaY) return;
    apply({ kind: 'wheel', direction: event.deltaY < 0 ? 'up' : 'down', ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey }, event);
  };
  const poll = () => {
    if (!document.hidden && document.hasFocus() && (recorder || preferences.bindings.some((r) => r.input?.kind === 'gamepad'))) {
      try { for (const input of gamepadEdges(navigator.getGamepads?.() ?? [], held)) apply(input); } catch { held.clear(); }
    } else held.clear();
  };
  const refreshGamepads = () => {
    clearInterval(gamepadTimer); gamepadTimer = undefined; held.clear();
    try {
      if ([...(navigator.getGamepads?.() ?? [])].some(Boolean)) gamepadTimer = setInterval(poll, 50);
    } catch { /* Gamepad API can be unavailable under browser policy. */ }
  };
  const reload = (event: StorageEvent) => { if (event.key === INPUT_BINDINGS_KEY || event.key === null) preferences.reload(); };
  const blur = () => { activeKeys.clear(); consumedButtons.clear(); held.clear(); recordShortcut(); };
  window.addEventListener('keydown', keyboard, true);
  window.addEventListener('keyup', keyboard, true);
  window.addEventListener('pointerdown', pointer, true);
  window.addEventListener('click', click, true);
  window.addEventListener('auxclick', click, true);
  window.addEventListener('contextmenu', click, true);
  window.addEventListener('wheel', wheel, { capture: true, passive: false });
  window.addEventListener('storage', reload);
  window.addEventListener('blur', blur);
  window.addEventListener('gamepadconnected', refreshGamepads);
  window.addEventListener('gamepaddisconnected', refreshGamepads);
  refreshGamepads();
  return () => {
    clearInterval(gamepadTimer); blur();
    window.removeEventListener('keydown', keyboard, true); window.removeEventListener('keyup', keyboard, true);
    window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('click', click, true);
    window.removeEventListener('auxclick', click, true); window.removeEventListener('contextmenu', click, true);
    window.removeEventListener('wheel', wheel, true); window.removeEventListener('storage', reload); window.removeEventListener('blur', blur);
    window.removeEventListener('gamepadconnected', refreshGamepads); window.removeEventListener('gamepaddisconnected', refreshGamepads);
  };
}
