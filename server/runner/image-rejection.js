/** A provider explicitly rejected image content, including llama.cpp's missing-mmproj 500. */
export function isImageRejectionError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (!/\b(?:400|415|422|500)\b/.test(lower)) return false;
  return /image_url|image input|image content|multimodal|vision|mmproj|invalid image|image not supported|unsupported content type|content\W+\d*\W*type.*image/.test(lower);
}

export function bodyHasImageParts(body) {
  return Array.isArray(body?.messages) && body.messages.some((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'));
}

export function stripImagePartsFromBody(body) {
  return {
    ...body,
    messages: body.messages.flatMap((message) => {
      if (message.role === 'user' && message.toolImageFollowUp) return [];
      if (!Array.isArray(message.content)) return [message];
      const images = message.content.filter((part) => part.type === 'image_url');
      if (images.length === 0) return [message];
      const text = message.content.filter((part) => part.type === 'text')
        .map((part) => part.text).filter(Boolean).join('\n\n');
      const note = images.map(() => '[image omitted — this model rejected image input]').join('\n');
      return [{ ...message, content: [text, note].filter(Boolean).join('\n\n') }];
    }),
  };
}
