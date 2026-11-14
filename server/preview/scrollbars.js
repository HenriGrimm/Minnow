import { readFileSync } from 'node:fs';

export const previewScrollbarCss = readFileSync(
  new URL('../../src/styles/scrollbars.css', import.meta.url),
  'utf8',
);

export const previewScrollbarStyle = `<style>${previewScrollbarCss}</style>`;
