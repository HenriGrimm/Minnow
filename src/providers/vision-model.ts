/**
 * Shared vision-model detection (catalog type + optional capabilities matrix).
 */

import { getModelRowForSelectOrCanonicalId } from '../api/models';
import { catalogRowHasVision } from './model-capabilities';
import type { LmModelRecord } from '../types';

/**
 * Positive-only id heuristic for catalogs that carry no vision signal at all
 * (llama.cpp, mlx-lm, MTPLX and friends list bare `{ id }` rows). Never used to
 * turn vision *off* — a false positive would send image parts to a text-only
 * runtime, which answers with an HTTP error instead of a reply.
 */
const VISION_ID_FALLBACK =
  /vlm|vision|llava|bakllava|moondream|multimodal|internvl|pixtral|idefics|\bvl\b|minicpm-?v\b/i;

/**
 * What we actually know about image input for a model.
 * - `yes`   — catalog, probe, or id heuristic says the model reads images.
 * - `no`    — an authoritative source says it does not (or a live request proved it).
 * - `unknown` — nothing in the catalog says anything either way.
 */
export type VisionSupport = 'yes' | 'no' | 'unknown';

/**
 * Models that answered a real request with an image-shaped rejection this session.
 * Keyed by the same id/select-key the chat sends, so an optimistic first attempt
 * costs one failed request per model, not one per message.
 */
const rejectedImageModels = new Set<string>();

/** Remember that this model rejected `image_url` content (set after a live 400). */
export function recordImageRejection(modelId: string | undefined): void {
  const id = modelId?.trim();
  if (id) rejectedImageModels.add(id);
}

/** True when a live request already proved this model cannot take image parts. */
export function hasRecordedImageRejection(modelId: string | undefined): boolean {
  const id = modelId?.trim();
  return Boolean(id && rejectedImageModels.has(id));
}

/** Test/reset hook for the session-scoped rejection memory. */
export function clearRecordedImageRejections(): void {
  rejectedImageModels.clear();
}

/**
 * `type: 'llm'` is only evidence on LM Studio, whose catalog distinguishes `vlm`.
 * Every other normalizer stamps `llm` on rows that never carried a type at all.
 */
function catalogRowTypeIsAuthoritative(row: LmModelRecord): boolean {
  return row.api === 'lm-studio-v0';
}

function visionFromRow(row: LmModelRecord): boolean | null {
  if (catalogRowHasVision(row)) return true;
  const vision = row.capabilities?.vision;
  if (vision === true) return true;
  if (vision === false && row.capabilities?.sources?.vision === 'probe') return false;
  if (row.catalogVision === false) return false;
  if (vision === false && catalogRowTypeIsAuthoritative(row)) return false;
  if (row.type === 'llm' && catalogRowTypeIsAuthoritative(row)) return false;
  return null;
}

/**
 * Three-state image-input support for a model.
 * Resolution: live rejection memory → modelCache (or the passed catalog) → id
 * heuristic → `unknown` when nothing anywhere has an opinion.
 */
export function resolveVisionSupport(
  modelId: string | undefined,
  catalog?: LmModelRecord[],
): VisionSupport {
  if (!modelId) return 'no';
  if (hasRecordedImageRejection(modelId)) return 'no';

  const heuristic = (id: string): VisionSupport =>
    VISION_ID_FALLBACK.test(id) ? 'yes' : 'unknown';

  if (catalog !== undefined) {
    const row = catalog.find((m) => m.id === modelId);
    if (row) {
      const fromCatalog = visionFromRow(row);
      if (fromCatalog !== null) return fromCatalog ? 'yes' : 'no';
    }
    return heuristic(modelId);
  }

  const cached = getModelRowForSelectOrCanonicalId(modelId);
  if (cached) {
    const fromCache = visionFromRow(cached);
    if (fromCache !== null) return fromCache ? 'yes' : 'no';
    return VISION_ID_FALLBACK.test(cached.id) ? 'yes' : heuristic(modelId);
  }

  return heuristic(modelId);
}

/**
 * True when the model is *known* to accept image_url multimodal user content.
 * Conservative: `unknown` reads as false. Use this for capability badges.
 * Image delivery uses canSendImagesToModel so incomplete catalogs do not
 * silently hide user attachments or tool screenshots.
 */
export function isVisionModel(modelId: string | undefined, catalog?: LmModelRecord[]): boolean {
  return resolveVisionSupport(modelId, catalog) === 'yes';
}

/**
 * True unless we have evidence the model rejects images.
 *
 * Use this for user attachments and tool screenshots: most OpenAI-compatible catalogs say nothing about vision, and
 * silently downgrading the attachment to a `[image: name]` filename is worse
 * than one recoverable 400 — {@link recordImageRejection} makes that cost
 * once-per-model, and the send path retries without the pixels.
 */
export function canSendImagesToModel(
  modelId: string | undefined,
  catalog?: LmModelRecord[],
): boolean {
  return resolveVisionSupport(modelId, catalog) !== 'no';
}

/**
 * True when an upstream error reads as "this model/endpoint will not take images".
 * Mirrors {@link isResponseFormatRejectionError}: status-gated first so an
 * unrelated 500 mentioning "image" never strips a user's attachment.
 */
export function isImageRejectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (
    !lower.includes('400') &&
    !lower.includes('415') &&
    !lower.includes('422') &&
    !lower.includes('500')
  ) {
    return false;
  }
  return (
    lower.includes('image_url') ||
    lower.includes('image input') ||
    lower.includes('image content') ||
    lower.includes('multimodal') ||
    lower.includes('vision') ||
    lower.includes('mmproj') ||
    lower.includes('no multimodal support') ||
    lower.includes('does not support image') ||
    lower.includes("doesn't support image") ||
    lower.includes('invalid image') ||
    lower.includes('image not supported') ||
    lower.includes('unsupported content type') ||
    /content\W+\d*\W*type.*image/.test(lower)
  );
}
