/**
 * Turn unknown throw values into a dialog / crash-log payload.
 * Node `fetch` failures are `TypeError: fetch failed` with the syscall on `error.cause`.
 */
export function formatUnknownError(err: unknown): {
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
} {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }

  const extra: Record<string, unknown> = {};
  let message = err.message;
  const cause = err.cause;

  if (cause instanceof Error) {
    extra.causeMessage = cause.message;
    const code =
      'code' in cause && typeof (cause as NodeJS.ErrnoException).code === 'string'
        ? (cause as NodeJS.ErrnoException).code
        : undefined;
    if (code) {
      extra.causeCode = code;
      message = `${err.message} (${code})`;
    }
    message = `${message}\nCaused by: ${cause.message}`;
  } else if (cause != null) {
    extra.cause = String(cause);
  }

  return {
    message,
    stack: err.stack,
    extra: Object.keys(extra).length ? extra : undefined,
  };
}
