export const TRANSCRIPT_REFINE_REQUIRED_CODE = "transcript_refine_required";

export class ApiError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/** Parse a failed fetch Response into a short user-facing message. */
export async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body: unknown = JSON.parse(text);
    const message = nestedApiMessage(body);
    if (message) {
      return message;
    }
  } catch {
    // not JSON
  }
  if (/host offline/i.test(text)) {
    return "Host offline — ask them to run podcast tunnel and try again.";
  }
  return text.trim() || `Request failed (${res.status})`;
}

function nestedApiMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return nestedApiMessage(record.message) ?? nestedApiMessage(record.detail);
}

/** Preserve a stable server error code alongside its display message. */
export async function readApiFailure(res: Response): Promise<ApiError> {
  return new ApiError(
    await readApiError(res),
    res.headers.get("X-Sharecut-Error-Code"),
  );
}
