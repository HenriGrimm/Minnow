/**
 * WCAG contrast helpers for custom theme validation in settings.
 */

export interface ContrastWarning {
  pair: string;
  ratio: number;
  minimum: number;
}

function parseHexOrRgb(color: string): [number, number, number] | null {
  const hex = color.trim();
  if (hex.startsWith('#')) {
    const h = hex.slice(1);
    const full =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h.length >= 6
          ? h.slice(0, 6)
          : null;
    if (!full) return null;
    const n = Number.parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(hex);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Contrast ratio between two CSS color strings (hex/rgb only). */
export function contrastRatio(fg: string, bg: string): number {
  const a = parseHexOrRgb(fg);
  const b = parseHexOrRgb(bg);
  if (!a || !b) return 0;
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_NORMAL = 4.5;
const AA_LARGE = 3;

/**
 * Return non-blocking warnings when key text/background pairs fall below WCAG AA.
 */
export function warnContrastPairs(tokens: Record<string, string>): ContrastWarning[] {
  const warnings: ContrastWarning[] = [];
  const pairs: Array<{ label: string; fg: string; bg: string; min: number }> = [
    { label: 'Main text on workspace background', fg: tokens.fg ?? '', bg: tokens.bg ?? '', min: AA_NORMAL },
    {
      label: 'Secondary text on workspace background',
      fg: tokens['fg-muted'] ?? '',
      bg: tokens.bg ?? '',
      min: AA_NORMAL,
    },
    {
      label: 'Text on primary buttons',
      fg: tokens['fg-on-accent'] ?? '',
      bg: tokens.accent ?? '',
      min: AA_NORMAL,
    },
    {
      label: 'Links on raised surfaces',
      fg: tokens['accent-ink'] ?? '',
      bg: tokens['surface-1'] ?? tokens.bg ?? '',
      min: AA_LARGE,
    },
  ];

  for (const { label, fg, bg, min } of pairs) {
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio > 0 && ratio < min) {
      warnings.push({ pair: label, ratio, minimum: min });
    }
  }
  return warnings;
}
