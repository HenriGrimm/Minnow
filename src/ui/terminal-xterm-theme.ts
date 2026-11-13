import type { ITheme } from '@xterm/xterm';
import { formatCssColor, parseCssColor } from '../appearance/color-format';
import { contrastRatio } from '../appearance/contrast';

function readToken(style: CSSStyleDeclaration, name: string, fallback: string): string {
  // xterm's palette and the contrast checks expect sRGB. Computed custom
  // properties can still contain color-mix() expressions and OKLab colors.
  const color = parseCssColor(style.getPropertyValue(name));
  return color ? formatCssColor(color) : fallback;
}

function rgb(color: string): [number, number, number] {
  const { r, g, b } = parseCssColor(color)!;
  return [r, g, b];
}

function mixSrgb(tint: string, background: string, weight: number): string {
  const base = rgb(background);
  const [r, g, b] = rgb(tint).map((channel, i) => channel * weight + base[i]! * (1 - weight));
  return formatCssColor({ r, g, b, a: 1 });
}

/** Pick the first candidate with WCAG AA contrast on the terminal canvas. */
function pickReadable(bg: string, candidates: string[], fallback: string): string {
  for (const candidate of candidates) {
    if (contrastRatio(candidate, bg) >= 4.5) return candidate;
  }
  return fallback;
}

/** Pick the darkest gold/amber token that stays readable on the terminal canvas. */
function pickLightAnsiYellow(style: CSSStyleDeclaration, bg: string, fg: string): string {
  return pickReadable(
    bg,
    [
      readToken(style, '--mn-folder', '#8a7040'),
      readToken(style, '--mn-warning', '#a3722a'),
      '#7a5520',
      fg,
    ],
    fg,
  );
}

/** xterm blends selection over its canvas, so compare the visible fill. */
function pickTerminalSelectionBackground(
  style: CSSStyleDeclaration,
  isLight: boolean,
  bg: string,
  fg: string,
  accent: string,
): string {
  const token = parseCssColor(style.getPropertyValue('--mn-selection-bg'));
  if (token) {
    const visible = mixSrgb(formatCssColor(token), bg, token.a);
    if (contrastRatio(visible, bg) >= 2 && contrastRatio(fg, visible) >= 4.5) {
      return visible;
    }
  }

  for (const color of [accent, fg]) {
    for (const weight of [0.25, 0.35, 0.45, 0.55, 0.65]) {
      const candidate = mixSrgb(color, bg, weight);
      if (contrastRatio(candidate, bg) >= 2 && contrastRatio(fg, candidate) >= 4.5) {
        return candidate;
      }
    }
  }

  return mixSrgb(fg, bg, isLight ? 0.35 : 0.25);
}

/** Build a full 16-color xterm theme from computed CSS variables. */
export function buildTerminalXtermTheme(style: CSSStyleDeclaration): ITheme {
  const isLight = style.colorScheme === 'light';
  const bg = readToken(style, '--mn-surface-0', isLight ? '#ffffff' : '#111113');
  const fg = readToken(style, '--mn-fg', isLight ? '#1c2127' : '#dfe3e8');
  const accent = readToken(style, '--mn-accent', isLight ? '#5b8a72' : '#9ec5a7');
  const selection = pickTerminalSelectionBackground(style, isLight, bg, fg, accent);

  const base: ITheme = {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: selection,
    selectionForeground: fg,
  };

  if (isLight) {
    const fgMuted = readToken(style, '--mn-fg-muted', '#5a626c');
    const dangerInk = readToken(style, '--mn-danger-ink', '#8a2f2b');
    const danger = readToken(style, '--mn-danger', '#c75651');
    const successInk = readToken(style, '--mn-success-ink', '#2d4f3c');
    const success = readToken(style, '--mn-success', '#4f7c63');
    const accentInk = readToken(style, '--mn-accent-ink', '#2d4f3c');
    const yellow = pickLightAnsiYellow(style, bg, fg);

    return {
      ...base,
      black: fg,
      red: dangerInk,
      green: successInk,
      yellow,
      blue: accentInk,
      magenta: pickReadable(bg, [dangerInk, danger, fg], fg),
      cyan: pickReadable(bg, [accent, accentInk, fg], fg),
      white: fgMuted,
      brightBlack: fgMuted,
      brightRed: pickReadable(bg, [danger, dangerInk, fg], fg),
      brightGreen: pickReadable(bg, [success, successInk, fg], fg),
      brightYellow: yellow,
      brightBlue: pickReadable(bg, [accent, accentInk, fg], fg),
      brightMagenta: dangerInk,
      brightCyan: accentInk,
      brightWhite: fg,
    };
  }

  return {
    ...base,
    black: readToken(style, '--mn-surface-2', '#1f242b'),
    red: readToken(style, '--mn-danger', '#e07a6f'),
    green: readToken(style, '--mn-success', '#9ec5a7'),
    yellow: readToken(style, '--mn-warning', '#d4a574'),
    blue: accent,
    magenta: readToken(style, '--mn-danger-ink', '#f5b5ae'),
    cyan: readToken(style, '--mn-accent-ink', '#cfe5d4'),
    white: readToken(style, '--mn-fg-muted', '#8a929c'),
    brightBlack: readToken(style, '--mn-fg-subtle', '#5a626c'),
    brightRed: readToken(style, '--mn-danger-ink', '#f5b5ae'),
    brightGreen: readToken(style, '--mn-success-ink', '#cfe5d4'),
    brightYellow: readToken(style, '--mn-folder', '#c8b173'),
    brightBlue: readToken(style, '--mn-accent-ink', '#cfe5d4'),
    brightMagenta: readToken(style, '--mn-danger', '#e07a6f'),
    brightCyan: accent,
    brightWhite: fg,
  };
}
