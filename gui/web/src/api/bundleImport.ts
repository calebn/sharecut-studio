import { apiFetch, HOST_KEY } from "./http";

const OCTET_STREAM = { "Content-Type": "application/octet-stream" };
const JSON_HEADERS = { "Content-Type": "application/json" };

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
  return (await res.json()) as T;
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
  return (await res.json()) as T;
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
