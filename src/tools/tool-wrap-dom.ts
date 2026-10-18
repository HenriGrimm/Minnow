function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** The live `.tool-call-msg` row for this call, or null when nothing is mounted. */
export function findToolWrapInDom(toolCallId: string, root?: ParentNode | null): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const id = toolCallId?.trim();
  if (!id) return null;
  return (root ?? document).querySelector<HTMLElement>(
    `.tool-call-msg[data-tool-call-id="${escapeAttributeValue(id)}"]`,
  );
}
