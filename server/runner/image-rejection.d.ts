/** True when a provider error explicitly rejects image or multimodal input. */
export function isImageRejectionError(err: unknown): boolean;

/** True when an OpenAI-compatible request body contains image_url parts. */
export function bodyHasImageParts(body: unknown): boolean;

/** Return a request body with rejected images replaced by explanatory text. */
export function stripImagePartsFromBody(body: Record<string, any>): Record<string, any>;
