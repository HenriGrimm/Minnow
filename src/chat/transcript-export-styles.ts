export const transcriptExportStyles = `
/* Embedded in standalone exports, independent of the application's active theme. */
:root {
  color-scheme: light;
  --mn-bg: oklch(0.985 0.004 150);
  --mn-fg: oklch(0.26 0.015 150);
  --mn-muted: oklch(0.48 0.018 150);
  --mn-border: oklch(0.86 0.012 150);
  --mn-surface: oklch(0.95 0.009 150);
  --mn-accent: oklch(0.39 0.07 150);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--mn-bg); color: var(--mn-fg); font: 16px/1.65 system-ui, -apple-system, 'Segoe UI', sans-serif; }
main { max-width: 78ch; margin: auto; padding: 48px 24px; }
header { padding-bottom: 28px; border-bottom: 1px solid var(--mn-border); margin-bottom: 32px; }
h1 { font-size: 2rem; line-height: 1.2; letter-spacing: -0.025em; overflow-wrap: anywhere; }
.eyebrow, .speaker { font-size: 0.75rem; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mn-accent); }
.caption, figcaption, footer { font-size: 0.8rem; color: var(--mn-muted); }
.message { margin: 32px 0; }
.user { margin-left: 8%; padding: 16px 20px; border-radius: 10px; background: var(--mn-surface); }
.speaker { margin: 0 0 10px; }
.user-text { white-space: pre-wrap; }
.prose { overflow-wrap: anywhere; }
.prose > :first-child { margin-top: 0; }
.prose > :last-child { margin-bottom: 0; }
.prose h1 { font-size: 1.6rem; }
.prose h2 { font-size: 1.3rem; }
.prose h3 { font-size: 1.1rem; }
a { color: var(--mn-accent); text-underline-offset: 3px; }
pre, code { font-family: ui-monospace, Consolas, monospace; font-size: 0.875rem; }
code { background: var(--mn-surface); padding: 2px 4px; border-radius: 3px; }
pre { max-width: 100%; overflow: auto; padding: 16px; background: var(--mn-surface); border: 1px solid var(--mn-border); border-radius: 6px; line-height: 1.5; }
pre code { padding: 0; }
blockquote { margin: 20px 0; padding: 12px 20px; background: var(--mn-surface); }
table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; }
th, td { border: 1px solid var(--mn-border); padding: 8px 12px; text-align: left; }
th { background: var(--mn-surface); }
.activity { border-bottom: 1px solid var(--mn-border); padding: 10px 0; font-size: 0.85rem; }
summary { cursor: pointer; color: var(--mn-muted); overflow-wrap: anywhere; }
summary:focus-visible { outline: 2px solid var(--mn-accent); outline-offset: 4px; }
figure { margin: 20px 0; }
img { max-width: 100%; height: auto; border-radius: 6px; }
footer { border-top: 1px solid var(--mn-border); margin-top: 48px; padding-top: 16px; }
@media (max-width: 600px) { main { padding: 24px 16px; } .user { margin-left: 0; } }
@media print {
  main { max-width: none; padding: 0; }
  body { background: transparent; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .message, figure { break-inside: avoid; }
}
`;
