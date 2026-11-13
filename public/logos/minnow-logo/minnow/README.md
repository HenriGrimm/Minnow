# Minnow logo assets

The mark is a **pixel minnow**: seven columns by five rows of cells. The tail is
three cells set as a `>` (the prompt) and the eye is one missing cell, so the
mark works in a single ink.

Everything here is generated from `src/lib/minnow-mark.mjs` by
`npm run logos:render` (which also refreshes `build/icon.ico` and the tray
icons). Change the mark there; do not hand-edit these files.

## Construction
- Grid: 7 × 5 cells, 23 filled.
- Vector master: cell 3 units, gap 1 unit, corner 0.67 units (`viewBox 0 0 100 100`).
- Under 48 px the gaps close or shrink and cells land on whole pixels. The
  16 px master is 2 px cells with no gap; 32, 48 and 64 px tiles have their
  own snapped grids. Never downscale the vector master to these sizes.

## SVG masters (`/svg`)
- `minnow-icon.svg` — primary app icon, 512×512 (graphite tile, sage minnow)
- `minnow-icon-light.svg` — light variant (white tile, graphite minnow)
- `minnow-glyph.svg` / `minnow-glyph-white.svg` / `minnow-glyph-accent.svg` — mark only, transparent
- `minnow-favicon.svg` — the 16 px pixel master on its tile
- `minnow-maskable.svg` — full-bleed square, mark inside the safe zone
- `minnow-lockup-horizontal.svg` — icon + wordmark + tagline
- `minnow-lockup-stacked.svg` — icon over wordmark + tagline

The lockup SVGs set type in Geist Mono (wordmark) and Geist (tagline); the PNGs
are rendered with the bundled fonts.

## PNGs (`/png`)
- `minnow-{16,32,48,64,96,128,180,192,256,384,512,1024}.png` — app icon ladder
- `favicon.ico`, `minnow-favicon-{16,32,48}.png` — favicons
- `apple-touch-icon.png` — 180×180, opaque square (iOS applies its own mask)
- `minnow-maskable-{192,512}.png` — PWA / Android adaptive icons
- `minnow-light-{128,256,512}.png` — light variant
- `minnow-glyph-{128,256,512}.png` — mark only, transparent
- `minnow-lockup-horizontal-{720,1440}.png`, `minnow-lockup-stacked-{400,800}.png`

## Colors
- Tile / ink: `#0f1216` (graphite)
- Minnow on dark: `#9ec5a7` (sage accent)
- Tagline grey: `#5a626c`
