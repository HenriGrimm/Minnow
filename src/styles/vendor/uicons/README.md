# Flaticon Uicons 4.0.0

Regular Rounded and Solid Rounded styles, downloaded from Flaticon's official
versioned CDN: https://cdn-uicons.flaticon.com/4.0.0/.

The npm package still publishes 3.3.1, which lacks `fi-rr-coral-reef`.
These styles replace the npm CSS imports and are bundled locally for offline use.
CSS font URLs are changed to local WOFF2 files; legacy WOFF/EOT fallbacks are
omitted because Minnow targets modern Chromium. Glyph definitions are unchanged.

Source paths for each style (`regular-rounded` or `solid-rounded`):

- `uicons-{style}/css/uicons-{style}.css`
- `uicons-{style}/webfonts/uicons-{style}.woff2`

UIcons by [Flaticon](https://www.flaticon.com/uicons). See LICENSE.
`npm run check:icons` validates the shared icon map against these bundled styles.

`node scripts/sync-uicons.mjs` generates `.used.css` files from icon references
in `src/` and `index.html` during prebuild. The full catalog and fonts stay intact;
the prior npm catalog is also retained for persisted custom issue icons.
Only those CSS rules enter the production bundle. Use literal class names
when adding icons so the scanner can discover them.
