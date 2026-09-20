const CACHE_NAME = "podcast-proxy-v1";

export async function cachedFetchArrayBuffer(
  url: string,
): Promise<ArrayBuffer> {
  if (typeof caches === "undefined") {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`fetch ${res.status}`);
    }
    return res.arrayBuffer();
  }
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) {
    return hit.arrayBuffer();
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${res.status}`);
  }
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
