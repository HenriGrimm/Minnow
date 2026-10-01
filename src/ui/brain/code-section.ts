/**
 * Brain app — Code section: the code map (architecture, files and call graph views over
 * the code index). Also hosted in the Code app main column by `code-brain-map.ts`.
 */

/** Load the code map for the active workspace and wire its controls once. */
export async function renderCodeSection(): Promise<void> {
  const { renderCodeMapPage } = await import('../code-map/page');
  await renderCodeMapPage();
}
