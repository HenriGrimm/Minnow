import { USER_IMAGE_NO_VISION_HINT, stripUserImageNoVisionHint } from './tool-image-follow-up.js';

const IMAGE_DATA = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Strip a stale hint from text parts while keeping the other parts intact. */
function withoutUserHintParts(parts) {
  let changed = false;
  const next = [];
  for (const part of parts) {
    if (part?.type !== 'text' || typeof part.text !== 'string') { next.push(part); continue; }
    const text = stripUserImageNoVisionHint(part.text);
    if (text === part.text) { next.push(part); continue; }
    changed = true;
    if (text.trim()) next.push({ ...part, text });
  }
  return changed ? next : parts;
}

/** Project persisted image bytes into provider content without mutating history. */
export function projectUserContent(message, { vision = true } = {}) {
  if (message?.role !== 'user') return message;
  if (!Object.hasOwn(message, 'images')) {
    // A stored row may keep the hint from a turn a text-only model answered
    // (an image-bearing steer loses its pixels there). A model that can read
    // images must not keep reading that refusal.
    if (!vision) return message;
    const content = Array.isArray(message.content)
      ? withoutUserHintParts(message.content)
      : stripUserImageNoVisionHint(message.content);
    return content === message.content ? message : { ...message, content };
  }
  const { images: savedImages, ...wire } = message;
  if (!Array.isArray(savedImages) || !savedImages.length) return wire;
  // Renderer-owned turns may already have projected the saved images. Preserve
  // their content parts instead of treating multimodal content as empty text.
  const existingParts = Array.isArray(wire.content) ? wire.content : null;
  const text = typeof wire.content === 'string' ? wire.content
    : (existingParts ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const images = savedImages.filter(image => typeof image?.dataUrl === 'string' && IMAGE_DATA.test(image.dataUrl));
  if (!vision || !images.length) {
    return { ...wire, content: stripUserImageNoVisionHint(text) + USER_IMAGE_NO_VISION_HINT };
  }
  if (existingParts?.some(part => part.type === 'image_url')) {
    const parts = withoutUserHintParts(existingParts);
    return parts === existingParts ? wire : { ...wire, content: parts };
  }
  const cleanText = stripUserImageNoVisionHint(text);
  const parts = existingParts ? withoutUserHintParts(existingParts) : cleanText.trim() ? [{ type: 'text', text: cleanText }] : [];
  for (const image of images) parts.push({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } });
  return { ...wire, content: parts };
}
