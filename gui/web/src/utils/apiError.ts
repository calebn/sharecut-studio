export const TRANSCRIPT_REFINE_REQUIRED_CODE = "transcript_refine_required";

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

/** User-facing message for any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for a 4xx the server answered: retrying the same request cannot succeed. */
export function isClientRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500
  );
}

const HOST_OFFLINE_MESSAGE =
  "Host offline — ask them to run podcast tunnel and try again.";

// FastAPI nests ``{detail: {detail: msg}}``; deeper shapes are not ours.
const MAX_MESSAGE_DEPTH = 3;

/** Parse a failed fetch Response into a short user-facing message. */
export async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  let message: string | null = null;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object") {
      message = nestedApiMessage(body, MAX_MESSAGE_DEPTH);
    }
  } catch {
    // not JSON
  }
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
