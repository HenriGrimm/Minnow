import { MINNOW_MARK_PIXEL, MINNOW_MARK_VECTOR } from '../lib/minnow-mark.mjs';

/**
 * Header-size logo mark (drawn at ~16–24px): the 16px pixel master, so every
 * cell lands on whole pixels instead of blurring. One ink — the eye is a gap.
 */
export const MINNOW_GLYPH_HEADER_HTML = `<svg class="minnow-glyph icon-svg" viewBox="${MINNOW_MARK_PIXEL.viewBox}" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="${MINNOW_MARK_PIXEL.d}"/></svg>`;

/** Empty chat state icon (larger): the vector master with rounded cells. */
export const MINNOW_GLYPH_EMPTY_HTML = `<svg class="minnow-glyph icon-svg" viewBox="${MINNOW_MARK_VECTOR.viewBox}" aria-hidden="true"><path fill="currentColor" d="${MINNOW_MARK_VECTOR.d}"/></svg>`;
