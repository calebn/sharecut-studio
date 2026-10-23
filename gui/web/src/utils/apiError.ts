import type { PipelineJobSnapshot } from "../types/pipeline";

export const PROJECT_WRITE_FAILED_CODE = "project_write_failed";
export const TRANSCRIPT_REFINE_REQUIRED_CODE = "transcript_refine_required";

export const TRANSCRIPT_REFINE_REFUSAL =
  "This is blocked until transcript refinement is done. A host can review the transcript or waive it with a reason.";

const MODEL_NEEDED_CODE = "model_needed";

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

/**
 * The server's plain words when a command could not write the project (disk full, folder not
 * writable): the server could not write, so no "may have been applied" guess is made.
 */
export function writeFailureReason(failure: ApiError): string | null {
  return failure.code === PROJECT_WRITE_FAILED_CODE ? failure.message : null;
}

export const PROJECT_NOT_FOUND_CODE = "project_not_found";
export const PROJECT_UNREADABLE_CODE = "project_unreadable";

export function projectUnavailableReason(
  failure: ApiError,
  guest: boolean,
): string | null {
  if (
    guest &&
    (failure.code === PROJECT_UNREADABLE_CODE ||
      failure.code === PROJECT_NOT_FOUND_CODE)
  ) {
    return "The project can't be saved right now. Ask the project owner to check it.";
  }
  if (failure.code === PROJECT_UNREADABLE_CODE) {
    return "The project file is damaged, so nothing can be saved. Restore it from a backup, or open a copy of the project.";
  }
  if (failure.code === PROJECT_NOT_FOUND_CODE) {
    return "The project file is missing, so nothing can be saved. Reopen the project from Home, or restore the file from a backup.";
  }
  return null;
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

/** The `model` object of a 409 body, as a failed job snapshot carries it. */
export function modelNeededFromPayload(raw: unknown): ModelNeeded | null {
  return pickModelNeeded({ model: raw });
}

/** The missing model a failed job snapshot names, or null for any other outcome. */
export function modelNeededOfJob(
  job: Pick<PipelineJobSnapshot, "status" | "error_code" | "error_model">,
): ModelNeeded | null {
  return job.status === "error" && job.error_code === MODEL_NEEDED_CODE
    ? modelNeededFromPayload(job.error_model)
    : null;
}

export function notDownloadedLine(model: ModelNeeded): string {
  return `${model.label} is not downloaded.`;
}

/** What to show for a failed job: a missing model reads plainly, never as the CLI command its raw text carries. */
export function jobErrorText(job: PipelineJobSnapshot): string | null {
  const model = modelNeededOfJob(job);
  return model ? notDownloadedLine(model) : job.error;
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
