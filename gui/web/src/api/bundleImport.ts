import { ApiError } from "../utils/apiError";
import { apiFetch, HOST_KEY } from "./http";

const OCTET_STREAM = { "Content-Type": "application/octet-stream" };
const JSON_HEADERS = { "Content-Type": "application/json" };

export const BAD_REPLY_CODE = "bad_reply";
export const BAD_REPLY_MESSAGE =
  "The server sent a reply this page can't read. Check your library, then try again.";

/** The body of a 2xx, or a plain refusal when it is not JSON (a captive portal's page, say). */
async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(BAD_REPLY_MESSAGE, BAD_REPLY_CODE, res.status);
  }
}

/** The two staged-import route families; each has `/preview`, a commit and a token delete. */
export type BundleBase = "/api/segments/import" | "/api/kits/import";

/** The service's temporary name for a file it is checking, as it appears in its refusals. */
const STAGING_NAME = /\b[0-9a-f]{16,}\.partial\b/;

/** A refusal that names the staging file names the file the person chose instead. */
function namedAfter(failure: unknown, file: File): unknown {
  if (!(failure instanceof ApiError) || !STAGING_NAME.test(failure.message))
    return failure;
  return new ApiError(
    failure.message.replace(STAGING_NAME, file.name),
    failure.code,
    failure.status,
    failure.model,
    failure.body,
    failure.retryAfterSec,
  );
}

/**
 * Sends the file as the raw body, so the browser streams it (no FormData); nothing is
 * added to the library until the commit.
 */
export async function stageBundle<T>(
  base: BundleBase,
  file: File,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const res = await apiFetch(
      HOST_KEY,
      { host: `${base}/preview` },
      { method: "POST", headers: OCTET_STREAM, body: file, signal },
    );
    return await readJson<T>(res);
  } catch (failure) {
    throw namedAfter(failure, file);
  }
}

export async function commitStaged<T>(
  base: BundleBase,
  token: string,
  signal?: AbortSignal,
): Promise<T> {
  const res = await apiFetch(
    HOST_KEY,
    { host: base },
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token }),
      signal,
    },
  );
  return readJson<T>(res);
}

/** Drops a staged file; `keepalive` lets it finish while the page closes. */
export async function cancelStaged(
  base: BundleBase,
  token: string,
): Promise<void> {
  await apiFetch(
    HOST_KEY,
    { host: `${base}/${encodeURIComponent(token)}` },
    { method: "DELETE", keepalive: true },
  );
}
