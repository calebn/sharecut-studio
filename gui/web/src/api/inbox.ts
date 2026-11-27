import { apiFetch, HOST_KEY } from "./http";

const inboxRoute = (id: string) => ({
  host: `/api/import/inbox/${encodeURIComponent(id)}`,
});

/** The file the native app received, read into the page under the name the host gave it. */
export async function fetchInboxFile(
  id: string,
  name: string,
  signal?: AbortSignal,
): Promise<File> {
  const res = await apiFetch(HOST_KEY, inboxRoute(id), { signal });
  return new File([await res.blob()], name);
}

/** Removes the received copy once the page holds the bytes. */
export async function dropInboxFile(id: string): Promise<void> {
  await apiFetch(HOST_KEY, inboxRoute(id), { method: "DELETE" });
}
