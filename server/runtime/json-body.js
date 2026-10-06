export const DEFAULT_JSON_BODY_LIMIT = 8 * 1024 * 1024;

function bodyError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export function jsonBodyErrorStatus(error, fallback = 400) {
  return error?.statusCode ?? fallback;
}

/** Bound retained bytes and release upload listeners on every terminal path. */
export function readJsonBody(req, maxBytes = DEFAULT_JSON_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
      chunks = [];
      if (error) reject(error);
      else resolve(value);
    };
    const onError = error => finish(error);
    const onAborted = () => finish(bodyError('Request aborted', 400));
    const onClose = () => { if (!req.complete) onAborted(); };
    const tooLarge = () => {
      finish(bodyError('Body too large', 413));
      // Drain without retaining bytes so the caller can send its 413 response.
      req.resume();
    };
    const onData = chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) tooLarge();
      else chunks.push(buffer);
    };
    const onEnd = () => {
      try {
        const raw = Buffer.concat(chunks, size).toString('utf8');
        finish(null, raw ? JSON.parse(raw) : {});
      } catch {
        finish(bodyError('Invalid JSON body', 400));
      }
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
    if (req.aborted || req.destroyed) onAborted();
    else if (Number(req.headers?.['content-length']) > maxBytes) tooLarge();
  });
}
