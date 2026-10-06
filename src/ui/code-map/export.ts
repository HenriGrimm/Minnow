/**
 * Save the current code map as a PNG by painting the laid-out scene onto a canvas
 * with the active theme's colours.
 */

import type { SceneLayout } from './layout';
import type { MapLink, MapNode } from './model';

const MAX_SIDE = 8000;

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** Resolve a CSS colour expression (tokens, color-mix) to something canvas accepts. */
function resolveColor(host: HTMLElement, value: string): string {
  const probe = document.createElement('span');
  probe.style.color = value;
  probe.style.display = 'none';
  host.append(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out || value;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** Paint the scene and return a PNG blob. Quiet links are left out, as on screen. */
export async function sceneToPng(
  host: HTMLElement,
  layout: SceneLayout,
  nodes: Map<string, MapNode>,
  links: MapLink[],
  toneOf: (frameTone: number) => string,
): Promise<Blob | null> {
  const scale = Math.min(2, MAX_SIDE / Math.max(layout.width, layout.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(layout.width * scale);
  canvas.height = Math.round(layout.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);

  const bg = resolveColor(host, cssVar(host, '--mn-surface-0', 'black'));
  const card = resolveColor(host, cssVar(host, '--mn-surface-1', 'black'));
  const border = resolveColor(host, cssVar(host, '--mn-border-strong', 'gray'));
  const fg = resolveColor(host, cssVar(host, '--mn-fg', 'white'));
  const muted = resolveColor(host, cssVar(host, '--mn-fg-muted', 'gray'));
  const linkColor = resolveColor(host, 'color-mix(in srgb, var(--mn-fg-muted) 55%, transparent)');
  const font = cssVar(document.documentElement, '--font-ui', 'system-ui, sans-serif');
  const mono = cssVar(document.documentElement, '--font-mono', 'monospace');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, layout.width, layout.height);

  for (const frame of layout.frames) {
    const tone = resolveColor(host, toneOf(frame.tone));
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = tone;
    roundRect(ctx, frame.x, frame.y, frame.w, frame.h, 14);
    ctx.fill();
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = tone;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = tone;
    ctx.font = `600 11px ${font}`;
    ctx.fillText(frame.label.toUpperCase(), frame.x + 20, frame.y + 24);
  }

  ctx.strokeStyle = linkColor;
  ctx.fillStyle = linkColor;
  for (const link of links) {
    if (link.quiet) continue;
    const d = layout.paths.get(link.id);
    if (!d) continue;
    ctx.lineWidth = Math.min(4.5, 1.25 + Math.log2(Math.max(1, link.n)) * 0.45);
    ctx.setLineDash(link.back ? [6, 5] : []);
    ctx.stroke(new Path2D(d));
  }
  ctx.setLineDash([]);

  for (const [id, box] of layout.boxes) {
    const node = nodes.get(id);
    if (!node) continue;
    ctx.fillStyle = card;
    roundRect(ctx, box.x, box.y, box.w, box.h, 10);
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.stroke();
    const textX = box.x + 14;
    const maxW = box.w - 28;
    const lines = [node.label, node.detail, node.kind === 'symbol' ? '' : node.meta].filter(Boolean);
    const lineH = 17;
    let y = box.y + box.h / 2 - ((lines.length - 1) * lineH) / 2 + 4;
    lines.forEach((text, i) => {
      ctx.fillStyle = i === 0 ? fg : muted;
      ctx.font = i === 0 ? `600 13px ${font}` : i === 1 ? `11px ${mono}` : `11px ${font}`;
      ctx.fillText(ellipsize(ctx, text, maxW), textX, y);
      y += lineH;
    });
  }

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}
