export const TRANSCRIPT_REFINE_REQUIRED_CODE = "transcript_refine_required";

export const TRANSCRIPT_REFINE_REFUSAL =
  "This is blocked until transcript refinement is done. A host can review the transcript or waive it with a reason.";

export class ApiError extends Error {
  readonly code: string | null;
  readonly status: number | null;

  constructor(
    message: string,
    code: string | null,
    status: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** User-facing message for any thrown value, with an optional non-Error fallback. */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof ApiError) return refusalReason(error);
  return error instanceof Error ? error.message : (fallback ?? String(error));
}

/**
 * What a refused command tells the host. The transcript-refine gate's server text names
 * command-line steps a phone host cannot run, so it reads as the one action the app offers.
 */
export function refusalReason(failure: ApiError): string {
  return failure.code === TRANSCRIPT_REFINE_REQUIRED_CODE
    ? TRANSCRIPT_REFINE_REFUSAL
    : failure.message;
}

/** An abort from an AbortSignal: a DOMException or any Error named "AbortError". */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function isServerTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return true;
  }
  const message = errorMessage(error);
  return message.includes("The server didn't answer.");
}

/** A rate limit, timeout or server error: the same request may succeed later. */
export function isRetryLater(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status === null) {
    return false;
  }
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

/**
 * A 4xx other than 408 / 429: the server refused this request for good
 * (validation, auth, conflict, revoked share), so retrying it cannot help.
 */
export function isPermanentRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    !isRetryLater(error)
  );
}

const HOST_OFFLINE_MESSAGE =
  "Host offline. Ask them to run podcast tunnel and try again.";

// FastAPI nests ``{detail: {detail: msg}}``; deeper shapes are not ours.
const MAX_MESSAGE_DEPTH = 3;

/** Parse a failed fetch Response into a short user-facing message. */
export async function readApiError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let message: string | null = null;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object") {
      message = nestedApiMessage(body, MAX_MESSAGE_DEPTH);
    }
  } catch {}
  const display = message ?? text.trim();
  if (/host offline/i.test(display)) {
    return HOST_OFFLINE_MESSAGE;
  }
  return display || `Request failed (${res.status})`;
}

function nestedApiMessage(value: unknown, depth: number): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (depth <= 0 || !value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return (
    nestedApiMessage(record.message, depth - 1) ??
    nestedApiMessage(record.detail, depth - 1)
  );
}

/** Preserve a stable server error code and HTTP status alongside its message. */
export async function readApiFailure(res: Response): Promise<ApiError> {
  return new ApiError(
    await readApiError(res),
    res.headers.get("X-Sharecut-Error-Code"),
    res.status,
  );
}
