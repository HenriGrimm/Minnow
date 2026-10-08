/** A delayed editor mount may focus only while its original focus intent still owns focus. */
const focusRevisions = new WeakMap<Document, { value: number }>();

export function captureEditorFocusRequest(doc: Document): () => boolean {
  let revision = focusRevisions.get(doc);
  if (!revision) {
    revision = { value: 0 };
    focusRevisions.set(doc, revision);
    doc.addEventListener('focusin', () => { revision!.value += 1; }, true);
  }
  const captured = revision.value;
  return () => revision!.value === captured;
}
