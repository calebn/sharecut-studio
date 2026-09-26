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
