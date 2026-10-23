export const TRANSCRIPT_REFINE_REQUIRED_CODE = "transcript_refine_required";

const TRANSCRIPT_REFINE_REFUSAL =
  "This is blocked until transcript refinement is done. A host can review the transcript or waive it with a reason.";

export const MODEL_NEEDED_CODE = "model_needed";

/** The model a host 409 asks to download; the install command is never kept. */
export type ModelNeeded = {
  id: string;
  variant: string | null;
  label: string;
  purpose: string;
  size: string;
  sizeBytes: number | null;
  state: string;
};

export class ApiError extends Error {
  readonly code: string | null;
  readonly status: number | null;
  readonly model: ModelNeeded | null;

  constructor(
    message: string,
    code: string | null,
    status: number | null = null,
    model: ModelNeeded | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.model = model;
  }
}

/** A host 409 naming the model to download; a guest 409 carries no model. */
export function isModelNeeded(
  error: unknown,
): error is ApiError & { model: ModelNeeded } {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === MODEL_NEEDED_CODE &&
    error.model !== null
  );
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
  return parseFailureText(text, res.status).message;
}

function parseFailureText(
  text: string,
  status: number,
): { message: string; body: unknown } {
  let message: string | null = null;
  let body: unknown = null;
  try {
    body = JSON.parse(text);
    if (body && typeof body === "object") {
      message = nestedApiMessage(body, MAX_MESSAGE_DEPTH);
    }
  } catch {}
  const display = message ?? text.trim();
  if (/host offline/i.test(display)) {
    return { message: HOST_OFFLINE_MESSAGE, body };
  }
  return { message: display || `Request failed (${status})`, body };
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

function pickModelNeeded(body: unknown): ModelNeeded | null {
  const top = asRecord(body);
  const model = asRecord(asRecord(top?.detail)?.model) ?? asRecord(top?.model);
  if (
    !model ||
    typeof model.id !== "string" ||
    typeof model.label !== "string" ||
    typeof model.size !== "string"
  ) {
    return null;
  }
  return {
    id: model.id,
    variant: typeof model.model === "string" ? model.model : null,
    label: model.label,
    purpose: typeof model.purpose === "string" ? model.purpose : "",
    size: model.size,
    sizeBytes:
      typeof model.size_bytes === "number" && Number.isFinite(model.size_bytes)
        ? model.size_bytes
        : null,
    state: typeof model.state === "string" ? model.state : "",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** Preserve a stable server error code and HTTP status alongside its message. */
export async function readApiFailure(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  const { message, body } = parseFailureText(text, res.status);
  const code = res.headers.get("X-Sharecut-Error-Code");
  const model =
    res.status === 409 && code === MODEL_NEEDED_CODE
      ? pickModelNeeded(body)
      : null;
  return new ApiError(message, code, res.status, model);
}
