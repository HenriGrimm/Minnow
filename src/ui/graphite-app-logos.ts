// App marks from the Graphite reference. The SVG is fixed, never user data.
const LOGOS = {
  "cursor": {
    "viewBox": "0 0 24 24",
    "body": "<path fill=\"currentColor\" opacity=\".5\" d=\"M12 2.2 20.6 7.1 12 12 3.4 7.1Z\"></path><path fill=\"currentColor\" opacity=\".78\" d=\"M3.4 7.1 12 12v9.8l-8.6-4.9Z\"></path><path fill=\"currentColor\" d=\"M20.6 7.1v9.8L12 21.8V12Z\"></path><path fill=\"none\" stroke=\"var(--sheet)\" stroke-width=\"1.1\" stroke-linejoin=\"round\" d=\"M12 12 20.6 7.1\"></path>"
  },
  "vscode": {
    "viewBox": "0 0 24 24",
    "body": "<path fill=\"#1F8AD2\" fill-rule=\"evenodd\" d=\"M16.3 1.8a1.3 1.3 0 0 1 1.5-.25l3.6 1.75c.45.22.75.68.75 1.18v15.04c0 .5-.3.96-.75 1.18l-3.6 1.75a1.3 1.3 0 0 1-1.5-.25L9.2 15.6l-3.1 2.4a.9.9 0 0 1-1.15-.05l-1.1-1a.9.9 0 0 1 0-1.33L6.5 12 3.85 9.4a.9.9 0 0 1 0-1.33l1.1-1a.9.9 0 0 1 1.15-.05l3.1 2.4ZM17.4 7.4 12.2 12l5.2 4.6Z\"></path><path fill=\"#0E5FA3\" d=\"M16.3 1.8 9.2 8.4 6.1 6.02a.9.9 0 0 0-1.15.05l-1.1 1a.9.9 0 0 0 0 1.33L6.5 12l2.7 3.6 8.2-8.2V1.6a1.3 1.3 0 0 0-1.1.2Z\" opacity=\".55\"></path>"
  },
  "finder": {
    "viewBox": "0 0 24 24",
    "body": "<rect x=\"2\" y=\"2\" width=\"20\" height=\"20\" rx=\"5\" fill=\"#1B84F2\"></rect><path fill=\"#8FD6FF\" d=\"M7 2h6.4c-1.4 3.1-2.2 6.3-2.3 9.6h2.1c-.15 3.5.25 6.9 1.2 10.4H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5Z\"></path><path d=\"M8 7.6v2.1M16 7.6v2.1\" stroke=\"#0F2440\" stroke-width=\"1.4\" stroke-linecap=\"round\"></path><path d=\"M6.9 15.3c3 2.1 7.2 2.1 10.2 0\" stroke=\"#0F2440\" stroke-width=\"1.3\" fill=\"none\" stroke-linecap=\"round\"></path>"
  }
} as const;

export type GraphiteHostApp = keyof typeof LOGOS;

export function createGraphiteAppLogo(app: GraphiteHostApp): SVGSVGElement {
  const logo = LOGOS[app];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('graphite-app-logo');
  svg.setAttribute('viewBox', logo.viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = logo.body;
  return svg;
}
