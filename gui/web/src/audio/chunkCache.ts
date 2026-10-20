import { apiFetch } from "../api/http";

const CACHE_NAME = "podcast-proxy-v1";

/** `url` is a server-issued chunk URL for the share `projectKey`. */
export async function cachedFetchArrayBuffer(
  projectKey: string,
  url: string,
): Promise<ArrayBuffer> {
  if (typeof caches === "undefined") {
    const res = await apiFetch(projectKey, { url });
    return res.arrayBuffer();
  }
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) {
    return hit.arrayBuffer();
  }
  const res = await apiFetch(projectKey, { url });
  const clone = res.clone();
  await cache.put(url, clone);
  return res.arrayBuffer();
}

export async function dropProxyCacheForHash(
  trackId: string,
  keepHash: string,
): Promise<void> {
  if (typeof caches === "undefined") {
    return;
  }
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  await Promise.all(
    keys.map(async (req) => {
      const u = req.url;
      if (u.includes(`/proxy/${trackId}/`) && !u.includes(`/${keepHash}/`)) {
        await cache.delete(req);
      }
    }),
  );
}
