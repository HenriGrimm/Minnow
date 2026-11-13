/**
 * The Minnow mark: a pixel minnow on a 7 × 5 cell grid.
 *
 * The tail is three cells set as a `>` (the prompt) and the eye is one missing
 * cell, so the mark works in a single ink. Every logo surface — the in-app
 * glyph, the boot loader, the generated PNG / ICO / tray assets — derives from
 * these rows, so change the mark here and re-run `npm run logos:render`.
 *
 * Shared by the renderer (via src/ui/minnow-glyph.ts) and scripts/render-logos.mjs.
 */

/** `X` = filled cell, `.` = empty. Row 1, column 5 is the eye. */
export const MINNOW_MARK_ROWS = Object.freeze([
  '...XXX.',
  'X.XXX.X',
  '.XXXXXX',
  'X.XXXXX',
  '...XXX.',
]);

export const MINNOW_MARK_COLS = 7;
export const MINNOW_MARK_ROW_COUNT = 5;

/** Filled cells in reading order, each with its grid position. */
export function minnowMarkCells() {
  const cells = [];
  MINNOW_MARK_ROWS.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] === 'X') cells.push({ r, c });
    }
  });
  return cells;
}

function num(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

/**
 * One SVG path for the whole mark.
 * @param {{ cell: number, step: number, x?: number, y?: number, radius?: number }} opts
 *   `cell` = cell size, `step` = cell + gap, `x`/`y` = top-left of the grid,
 *   `radius` = corner radius (0 = square, crisp at pixel sizes).
 */
export function minnowMarkPath({ cell, step, x = 0, y = 0, radius = 0 }) {
  const r = Math.max(0, Math.min(radius, cell / 2));
  const side = cell - 2 * r;
  let d = '';
  for (const { r: row, c } of minnowMarkCells()) {
    const cx = x + c * step;
    const cy = y + row * step;
    if (r === 0) {
      d += `M${num(cx)} ${num(cy)}h${num(cell)}v${num(cell)}h${num(-cell)}z`;
      continue;
    }
    d +=
      `M${num(cx + r)} ${num(cy)}h${num(side)}a${num(r)} ${num(r)} 0 0 1 ${num(r)} ${num(r)}` +
      `v${num(side)}a${num(r)} ${num(r)} 0 0 1 ${num(-r)} ${num(r)}` +
      `h${num(-side)}a${num(r)} ${num(r)} 0 0 1 ${num(-r)} ${num(-r)}` +
      `v${num(-side)}a${num(r)} ${num(r)} 0 0 1 ${num(r)} ${num(-r)}z`;
  }
  return d;
}

/**
 * The vector master: cell 9, gap 3, corner 2 in a 100 × 100 box (grid 81 × 57,
 * centred). Use for anything drawn larger than ~48 px.
 */
export const MINNOW_MARK_VECTOR = Object.freeze({
  viewBox: '0 0 100 100',
  d: minnowMarkPath({ cell: 9, step: 12, x: 9.5, y: 21.5, radius: 2 }),
});

/**
 * The 16 px master: 2 px cells, no gap, whole-pixel aligned. Use for UI glyphs
 * drawn at 14–24 px, favicons and tray icons, with `shape-rendering="crispEdges"`.
 */
export const MINNOW_MARK_PIXEL = Object.freeze({
  viewBox: '0 0 16 16',
  d: minnowMarkPath({ cell: 2, step: 2, x: 1, y: 3 }),
});
