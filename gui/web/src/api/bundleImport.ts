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

/**
 * Sends the file as the raw body, so the browser streams it (no FormData); nothing is
 * added to the library until the commit.
 */
export async function stageBundle<T>(
  base: BundleBase,
  file: File,
  signal?: AbortSignal,
): Promise<T> {
  const res = await apiFetch(
    HOST_KEY,
    { host: `${base}/preview` },
    { method: "POST", headers: OCTET_STREAM, body: file, signal },
  );
  return readJson<T>(res);
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
