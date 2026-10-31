let resolveTitle: (chatId: string) => string | undefined = () => undefined;

/** Read lightweight session titles without coupling Markdown to session hydration. */
export function chatReferenceTitle(chatId: string): string | undefined {
  return resolveTitle(chatId)?.trim() || undefined;
}

export function setChatReferenceTitleResolver(resolver: typeof resolveTitle): void {
  resolveTitle = resolver;
}
