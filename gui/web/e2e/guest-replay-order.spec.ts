import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { trackHeaderButton } from "./trackHeader";

/**
 * A guest tab closed with an edit still queued; the next tab has a new
 * client id and restarts `client_seq` at 1. Replay follows the stored queue,
 * so the older tab's edit lands first and the newer edit decides the result.
 */

interface PostedCommand {
  command_id: string;
  client_id: string;
  client_seq: number;
  type: string;
  payload: { muted?: boolean };
}

function guestMuted(projectPath: string): boolean {
  const data = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const find = (value: unknown): boolean | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = find(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (value === null || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (record.id === "guest" && typeof record.muted === "boolean")
      return record.muted;
    for (const child of Object.values(record)) {
      const found = find(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const muted = find(data);
  if (muted === undefined) throw new Error("guest track not found");
  return muted;
}

async function seedStoredCommand(
  page: Page,
  token: string,
  command: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ key, row }) =>
      new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open("podcast-daw-offline", 1);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const store = db.transaction("kv", "readwrite").objectStore("kv");
          const read = store.get(key);
          read.onsuccess = () => {
            store.put([...((read.result as unknown[]) ?? []), row], key);
          };
          store.transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          store.transaction.onerror = () => reject(store.transaction.error);
        };
      }),
    { key: `queue:${token}`, row: command },
  );
}

function storedQueue(page: Page, token: string): Promise<PostedCommand[]> {
  return page.evaluate(
    (key) =>
      new Promise<PostedCommand[]>((resolve, reject) => {
        const opened = indexedDB.open("podcast-daw-offline", 1);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const read = db
            .transaction("kv", "readonly")
            .objectStore("kv")
            .get(key);
          read.onerror = () => reject(read.error);
          read.onsuccess = () => {
            db.close();
            resolve((read.result as PostedCommand[] | undefined) ?? []);
          };
        };
      }),
    `queue:${token}`,
  );
}

test("a prior tab's queued edit replays before a later tab's edit, and the later edit wins", async ({
  browser,
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openHostShare(page, projectPath);
    const token = await createReviewShare(page, projectPath, "editor");
    expect(guestMuted(projectPath)).toBe(false);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    try {
      const priorTab = await context.newPage();
      await openGuestShare(priorTab, token);
      await seedStoredCommand(priorTab, token, {
        client_id: "viewer-prior",
        command_id: "prior-tab-unmute",
        client_seq: 9,
        type: "SetTrackMute",
        payload: { track_id: "guest", muted: false },
        created_at: Date.now() - 60_000,
      });
      await priorTab.close();

      const guest = await context.newPage();
      const commandRoute = "**/api/review/*/daw/document/command";
      await guest.route(commandRoute, (route) => route.abort("failed"));
      await openGuestShare(guest, token);
      await trackHeaderButton(guest, "guest").hover();
      await guest.getByRole("button", { name: "Mute guest" }).click();
      await expect
        .poll(async () => (await storedQueue(guest, token)).length)
        .toBe(2);
      expect(
        (await storedQueue(guest, token)).map((row) => row.client_seq),
      ).toEqual([9, 1]);

      const posted: PostedCommand[] = [];
      guest.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/command"))
          posted.push(request.postDataJSON() as PostedCommand);
      });
      await guest.unroute(commandRoute);
      await guest.evaluate(() => window.dispatchEvent(new Event("online")));

      await expect.poll(() => posted.length).toBe(2);
      expect(
        posted.map(({ client_id, client_seq, payload }) => ({
          client_id,
          client_seq,
          muted: payload.muted,
        })),
      ).toEqual([
        { client_id: "viewer-prior", client_seq: 9, muted: false },
        {
          client_id: expect.stringMatching(/^viewer-/),
          client_seq: 1,
          muted: true,
        },
      ]);
      expect(posted[1].client_id).not.toBe("viewer-prior");
      await expect.poll(() => guestMuted(projectPath)).toBe(true);
      await expect
        .poll(async () => (await storedQueue(guest, token)).length)
        .toBe(0);
    } finally {
      await context.close();
    }
  });
});
