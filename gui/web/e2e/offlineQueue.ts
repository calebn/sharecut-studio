import type { Page } from "@playwright/test";

/** Read the persisted host command count through the page's IndexedDB origin. */
export function hostOfflineQueueCount(
  page: Page,
  projectPath: string,
): Promise<number> {
  return page.evaluate(async (path) => {
    return new Promise<number>((resolve, reject) => {
      const opened = indexedDB.open("podcast-daw-offline", 1);
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const db = opened.result;
        const request = db
          .transaction("kv", "readonly")
          .objectStore("kv")
          .get(`host-queue:${path}`);
        request.onerror = () => {
          db.close();
          reject(request.error);
        };
        request.onsuccess = () => {
          db.close();
          resolve((request.result as unknown[] | undefined)?.length ?? 0);
        };
      };
    });
  }, projectPath);
}

/** The copy of the episode a guest saved for this review link, or null. */
export const guestSavedCopy = (page: Page, token: string) =>
  page.evaluate(
    (key) =>
      new Promise<unknown>((resolve, reject) => {
        const opened = indexedDB.open("podcast-daw-offline", 1);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const read = db
            .transaction("kv", "readonly")
            .objectStore("kv")
            .get(key);
          read.onsuccess = () => {
            db.close();
            resolve(read.result ?? null);
          };
          read.onerror = () => reject(read.error);
        };
      }),
    `snap:${token}`,
  );

/** The name of the cache that holds one review link's audio, and the old cache every link shared. */
const LINK_AUDIO_CACHE = "sharecut-link-audio:";
export const SHARED_AUDIO_CACHE = "podcast-proxy-v1";

/**
 * The audio the guest's browser keeps in Cache Storage: the entries and bytes
 * held for this link, and the entries left in the old cache every link shared.
 * Names carry the token, so only counts leave the page.
 */
export const guestLinkAudio = (page: Page, token: string) =>
  page.evaluate(
    async ([linkName, sharedName]) => {
      const sizeOf = async (name: string) => {
        if (typeof caches === "undefined" || !(await caches.has(name)))
          return { entries: 0, bytes: 0 };
        const cache = await caches.open(name);
        const keys = await cache.keys();
        let bytes = 0;
        for (const key of keys) {
          const res = await cache.match(key);
          bytes += res ? (await res.arrayBuffer()).byteLength : 0;
        }
        return { entries: keys.length, bytes };
      };
      return {
        ...(await sizeOf(linkName!)),
        shared: (await sizeOf(sharedName!)).entries,
      };
    },
    [`${LINK_AUDIO_CACHE}${token}`, SHARED_AUDIO_CACHE],
  );
