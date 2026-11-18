import { apiFetch } from "../api/http";
import { shareTokenFromKey } from "../shareMode";
import { isLinkEnded } from "../utils/linkEnded";
import { chunkRefKey, type ImmutableChunkRef } from "./proxyMath";

/**
 * Each review link keeps its audio in a cache of its own, so forgetting a link
 * is one delete of one name and cannot touch another link's audio.
 */
const LINK_AUDIO_PREFIX = "sharecut-link-audio:";

/**
 * The cache that all links shared under this name. Its entries are keyed by
 * URL and can belong to links that ended long ago, so it is deleted and never read.
 */
const SHARED_CACHE = "podcast-proxy-v1";

/**
 * A link's generation moves on only when its audio is forgotten. A chunk that
 * started before then must not leave anything behind after it.
 */
const generations = new Map<string, number>();
let sharedCacheDropped = false;

const generationOf = (token: string) => generations.get(token) ?? 0;
const cacheName = (token: string) => `${LINK_AUDIO_PREFIX}${token}`;

/**
 * A chunk is kept under what it is (kind, track or artifact, hash, index), not
 * under the address the server gave it: an object store hands out a new signed
 * address on every manifest read. The address is never requested.
 */
const entryAddress = (ref: ImmutableChunkRef) =>
  new URL(
    `/link-audio/${encodeURIComponent(chunkRefKey(ref))}`,
    globalThis.location.href,
  ).href;

async function deleteCache(name: string): Promise<void> {
  try {
    await caches.delete(name);
  } catch {
    // A cache that cannot be deleted is deleted when the dead link is next opened.
  }
}

function dropSharedCacheOnce(): void {
  if (sharedCacheDropped) return;
  sharedCacheDropped = true;
  void deleteCache(SHARED_CACHE);
}

/** The chunk's address, or null: an address that cannot be made means no cache this time, never a failed chunk. */
function addressOrNull(ref: ImmutableChunkRef): string | null {
  try {
    return entryAddress(ref);
  } catch {
    return null;
  }
}

/** The link's cache, or null when the browser will not give one: the cache is an aid, never a reason for audio to fail. */
async function openLinkCache(token: string): Promise<Cache | null> {
  try {
    dropSharedCacheOnce();
    return await caches.open(cacheName(token));
  } catch {
    return null;
  }
}

async function readHit(cache: Cache, address: string) {
  try {
    const hit = await cache.match(address);
    return hit ? await hit.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** `ref.url` is a server-issued chunk URL for the share `projectKey`. */
export async function cachedFetchArrayBuffer(
  projectKey: string,
  ref: ImmutableChunkRef,
): Promise<ArrayBuffer> {
  const token = shareTokenFromKey(projectKey);
  // An ended link reads nothing from the device: the request layer refuses it.
  if (token === null || typeof caches === "undefined" || isLinkEnded(token)) {
    return (await apiFetch(projectKey, { url: ref.url })).arrayBuffer();
  }
  const generation = generationOf(token);
  const address = addressOrNull(ref);
  const cache = address === null ? null : await openLinkCache(token);
  try {
    if (cache && address !== null) {
      const hit = await readHit(cache, address);
      if (hit) return hit;
    }
    const res = await apiFetch(projectKey, { url: ref.url });
    const copy = res.clone();
    // The bytes come first: nothing the cache does may keep them from the player.
    const bytes = await res.arrayBuffer();
    if (
      cache &&
      address !== null &&
      generationOf(token) === generation &&
      !isLinkEnded(token)
    ) {
      try {
        await cache.put(address, copy);
      } catch {
        // Quota or blocked storage: the audio plays, it is just not kept.
      }
    }
    return bytes;
  } finally {
    // A write or an open that finished after the forgetting would leave audio
    // behind, so the cache goes again, issued after that write has settled.
    if (cache && generationOf(token) !== generation)
      await deleteCache(cacheName(token));
  }
}

/**
 * The link has ended: its audio goes, and what is still on its way is not kept.
 * Never rejects, writes nothing to the console and creates no cache.
 */
export async function forgetLinkAudio(token: string): Promise<void> {
  generations.set(token, generationOf(token) + 1);
  if (typeof caches === "undefined") return;
  sharedCacheDropped = true;
  await Promise.all([deleteCache(cacheName(token)), deleteCache(SHARED_CACHE)]);
}

/**
 * Drops what the link's current version no longer names, so a re-rendered
 * episode does not pile up. Never rejects and never creates a cache.
 */
export async function pruneLinkAudio(
  token: string,
  keep: readonly ImmutableChunkRef[],
): Promise<void> {
  try {
    if (typeof caches === "undefined" || isLinkEnded(token)) return;
    const generation = generationOf(token);
    if (!(await caches.has(cacheName(token)))) return;
    try {
      const cache = await caches.open(cacheName(token));
      const wanted = new Set(keep.map(entryAddress));
      const kept = await cache.keys();
      await Promise.allSettled(
        kept
          .filter((request) => !wanted.has(request.url))
          .map((request) => cache.delete(request)),
      );
    } finally {
      if (generationOf(token) !== generation)
        await deleteCache(cacheName(token));
    }
  } catch {
    // Pruning is housekeeping; the next accepted manifest tries again.
  }
}
