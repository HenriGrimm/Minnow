/**
 * Parse and format CSS color strings for custom theme token editors.
 */

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function clampAlpha(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function hexPair(n: number): string {
  return clampByte(n).toString(16).padStart(2, '0');
}

let colorProbe: CanvasRenderingContext2D | null | undefined;

function parseBrowserColor(value: string): RgbaColor | null {
  if (typeof document === 'undefined' || !globalThis.CSS?.supports('color', value)) return null;
  colorProbe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!colorProbe) return null;
  // Reset twice so context-dependent values such as unresolved var() do not
  // accidentally return the previous token’s color.
  colorProbe.fillStyle = '#000';
  colorProbe.fillStyle = value;
  const dark = colorProbe.fillStyle;
  colorProbe.fillStyle = '#fff';
  colorProbe.fillStyle = value;
  if (colorProbe.fillStyle !== dark) return null;
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
}

/** Parse hex and rgb()/rgba(), with browser resolution for computed palette colors. */
export function parseCssColor(input: string): RgbaColor | null {
  const s = input.trim();
  if (!s) return null;

  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) {
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    }
    if (h.length === 6) {
      const n = Number.parseInt(h, 16);
      if (Number.isNaN(n)) return null;
      return {
        r: (n >> 16) & 255,
        g: (n >> 8) & 255,
        b: n & 255,
        a: 1,
      };
    }
    if (h.length === 8) {
      const n = Number.parseInt(h, 16);
      if (Number.isNaN(n)) return null;
      return {
        r: (n >> 24) & 255,
        g: (n >> 16) & 255,
        b: (n >> 8) & 255,
        a: clampAlpha(((n & 255) / 255)),
      };
    }
    return null;
  }

  const rgb = /^rgba?\(\s*([\d.]+)(?:%)?\s*,\s*([\d.]+)(?:%)?\s*,\s*([\d.]+)(?:%)?(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(
    s,
  );
  if (rgb) {
    const toChannel = (v: string, isPercent: boolean) => {
      const n = Number(v);
      if (Number.isNaN(n)) return 0;
      return isPercent ? clampByte((n / 100) * 255) : clampByte(n);
    };
    const isPercent = s.includes('%');
    const a = rgb[4] !== undefined ? clampAlpha(Number(rgb[4])) : 1;
    return {
      r: toChannel(rgb[1], isPercent),
      g: toChannel(rgb[2], isPercent),
      b: toChannel(rgb[3], isPercent),
      a,
    };
  }

  return parseBrowserColor(s);
}

/** Format RGBA as #rrggbb when opaque, otherwise rgba(r, g, b, a). */
export function formatCssColor(color: RgbaColor): string {
  const { r, g, b, a } = color;
  if (a >= 1) {
    return `#${hexPair(r)}${hexPair(g)}${hexPair(b)}`;
  }
  const alpha = Math.round(a * 1000) / 1000;
  return `rgba(${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)}, ${alpha})`;
}

/** Value for native color input (#rrggbb). */
export function rgbaToColorInputValue(color: RgbaColor): string {
  return `#${hexPair(color.r)}${hexPair(color.g)}${hexPair(color.b)}`;
}

/** Best-effort parse with opaque black fallback for invalid strings. */
export function parseCssColorOrDefault(input: string): RgbaColor {
  return parseCssColor(input) ?? { r: 0, g: 0, b: 0, a: 1 };
}
