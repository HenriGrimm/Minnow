import { USER_IMAGE_NO_VISION_HINT } from './tool-image-follow-up.js';

const IMAGE_DATA = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Project persisted image bytes into provider content without mutating history. */
export function projectUserContent(message, { vision = false } = {}) {
  if (message?.role !== 'user' || !Object.hasOwn(message, 'images')) return message;
  const { images: savedImages, ...wire } = message;
  if (!Array.isArray(savedImages) || !savedImages.length) return wire;
  const text = typeof wire.content === 'string' ? wire.content : '';
  const images = savedImages.filter(image => typeof image?.dataUrl === 'string' && IMAGE_DATA.test(image.dataUrl));
  if (!vision || !images.length) {
    return { ...wire, content: text + (text.includes(USER_IMAGE_NO_VISION_HINT) ? '' : USER_IMAGE_NO_VISION_HINT) };
  }
  const parts = text.trim() ? [{ type: 'text', text }] : [];
  for (const image of images) parts.push({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } });
  return { ...wire, content: parts };
}
