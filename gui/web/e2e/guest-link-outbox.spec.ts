import { expect, type Page, type Route, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { DEAD_TITLE, revokeLink, SIZES, withGuestLink } from "./guestLink";
import { openGuestShare } from "./shareNavigation";

const DESKTOP = SIZES[1];
const TEXT = "A note I wrote while the host was away";
const KEPT_LINE = "Comment kept. It sends when you can reach the host.";
const REFUSED = {
  status: 403,
  headers: {
    "content-type": "application/json",
    "x-sharecut-error-code": "share_capability_required",
  },
  body: JSON.stringify({ detail: "share does not allow comments" }),
};

const light = (page: Page) => page.locator(".sys-save").first();
const field = (page: Page) =>
  page.getByRole("textbox", { name: "Comment", exact: true });
const post = (page: Page) =>
  page.getByRole("button", { name: "Post", exact: true });
const commentRows = (page: Page) =>
  page.locator('.sys-queue-row[data-kind="comment"]');
const waitingRows = (page: Page) =>
  commentRows(page).filter({ hasText: "Waiting to send" });
const attention = (page: Page) =>
  page.getByRole("group", { name: /Needs attention/ });

async function serverComments(
  page: Page,
  token: string,
): Promise<{ id: string; body: string }[]> {
  const res = await page.request.get(`/api/review/${token}/project`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { comments: { id: string; body: string }[] })
    .comments;
}

type Send = (route: Route) => Promise<void>;

async function hostSends(page: Page, token: string, send: Send) {
  const seen = { posts: 0 };
  const pattern = `**/api/review/${token}/comments*`;
  const handler = async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    seen.posts += 1;
    return send(route);
  };
  await page.context().route(pattern, handler);
  return {
    seen,
    lift: () => page.context().unroute(pattern, handler),
  };
}

const unreachable: Send = (route) => route.abort("connectionrefused");

const deviceBack = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event("online")));

const stored = (page: Page, key: string) =>
  page.evaluate(
    (name) =>
      new Promise<unknown>((resolve, reject) => {
        const opened = indexedDB.open("podcast-daw-offline", 1);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const read = db
            .transaction("kv", "readonly")
            .objectStore("kv")
            .get(name);
          read.onsuccess = () => {
            db.close();
            resolve(read.result ?? null);
          };
          read.onerror = () => reject(read.error);
        };
      }),
    key,
  );

async function keepReplyTo(page: Page, token: string) {
  await page.evaluate(
    (name) =>
      new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open("podcast-daw-offline", 1);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const tx = db.transaction("kv", "readwrite");
          const store = tx.objectStore("kv");
          const read = store.get(name);
          read.onsuccess = () => {
            const rows = read.result as { id: string; created_at: number }[];
            store.put(
              [
                ...rows,
                {
                  id: "c".repeat(32),
                  kind: "reply",
                  body: "A reply to it",
                  author: "Guest",
                  created_at: rows[0].created_at + 1,
                  parent_comment_id: `g-${rows[0].id}`,
                },
              ],
              name,
            );
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    `outbox:${token}`,
  );
}

async function writeComment(page: Page, text: string) {
  await field(page).fill(text);
  await post(page).click();
}

test.describe("a guest's comment while the host cannot be reached", () => {
  test("is kept, survives a reload, and is posted once when the host answers", async ({
    browser,
  }) => {
    await withGuestLink(browser, DESKTOP, async (guest, token) => {
      await openGuestShare(guest, token);
      const away = await hostSends(guest, token, unreachable);

      await writeComment(guest, TEXT);
      await expect(field(guest)).toHaveValue("");
      await expect(
        guest.getByRole("status").filter({ hasText: KEPT_LINE }),
      ).toBeVisible();
      await expect(waitingRows(guest)).toHaveCount(1);
      await expect(waitingRows(guest)).toContainText(TEXT);
      await expect(light(guest)).toContainText("1 waiting");
      await expect(attention(guest)).toContainText("1 comment waiting to send");
      expect(await serverComments(guest, token)).toEqual([]);

      await openGuestShare(guest, token);
      await expect(waitingRows(guest)).toHaveCount(1);
      await expect(light(guest)).toContainText("1 waiting");

      await away.lift();
      await deviceBack(guest);
      await expect
        .poll(async () => (await serverComments(guest, token)).length)
        .toBe(1);
      await expect(waitingRows(guest)).toHaveCount(0);
      await expect(commentRows(guest)).toHaveCount(1);
      await expect(commentRows(guest)).toContainText(TEXT);
      await expect(light(guest)).toHaveText("Saved");
      await expect(attention(guest)).toHaveCount(0);
      expect((await serverComments(guest, token))[0]?.body).toBe(TEXT);
    });
  });

  test("is not posted twice when the first send landed and its answer was lost", async ({
    browser,
  }) => {
    await withGuestLink(browser, DESKTOP, async (guest, token) => {
      await openGuestShare(guest, token);
      let lost = true;
      const flaky = await hostSends(guest, token, async (route) => {
        if (!lost) return route.continue();
        lost = false;
        await route.fetch();
        return route.abort("connectionreset");
      });

      await writeComment(guest, TEXT);
      await expect(field(guest)).toHaveValue("");
      await expect
        .poll(async () => (await serverComments(guest, token)).length)
        .toBe(1);
      await expect(light(guest)).toContainText("1 waiting");

      await deviceBack(guest);
      await expect(light(guest)).toHaveText("Saved");
      await expect(waitingRows(guest)).toHaveCount(0);
      await expect(commentRows(guest)).toHaveCount(1);
      expect(flaky.seen.posts).toBe(2);
      expect(await serverComments(guest, token)).toHaveLength(1);
    });
  });

  test("goes back to the guest with the reason when the host refuses it, and survives a reload", async ({
    browser,
  }) => {
    await withGuestLink(browser, DESKTOP, async (guest, token) => {
      await guest
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"]);
      await openGuestShare(guest, token);
      const away = await hostSends(guest, token, unreachable);
      await writeComment(guest, TEXT);
      await expect(waitingRows(guest)).toHaveCount(1);
      await away.lift();
      const refusing = await hostSends(guest, token, (route) =>
        route.fulfill(REFUSED),
      );

      await deviceBack(guest);
      await expect(waitingRows(guest)).toHaveCount(0);
      await expect(attention(guest)).toContainText(
        "Your comment at 0:00 was not posted",
      );
      await expect(attention(guest)).toContainText(
        "This link no longer allows comments.",
      );
      await expect(attention(guest)).toContainText(TEXT);
      await expectPageAxeClean(guest);

      await openGuestShare(guest, token);
      await expect(attention(guest)).toContainText(TEXT);
      expect(refusing.seen.posts).toBeGreaterThanOrEqual(1);

      await attention(guest)
        .getByRole("button", { name: "Copy your comment at 0:00" })
        .click();
      await expect(
        guest.getByRole("status").filter({ hasText: "Copied your comment" }),
      ).toBeVisible();
      expect(await guest.evaluate(() => navigator.clipboard.readText())).toBe(
        TEXT,
      );

      await attention(guest)
        .getByRole("button", {
          name: "Put it back in the comment field: your comment at 0:00",
        })
        .click();
      await expect(field(guest)).toHaveValue(TEXT);
      await expect(attention(guest)).toHaveCount(0);
      expect(await serverComments(guest, token)).toEqual([]);

      await openGuestShare(guest, token);
      await expect(attention(guest)).toHaveCount(0);
    });
  });

  test("is called back with Don't send, and Undo puts it back", async ({
    browser,
  }) => {
    await withGuestLink(browser, DESKTOP, async (guest, token) => {
      await openGuestShare(guest, token);
      await hostSends(guest, token, unreachable);
      await writeComment(guest, TEXT);
      await expect(waitingRows(guest)).toHaveCount(1);

      await guest
        .getByRole("button", { name: /^Don't send: comment by/ })
        .first()
        .click();
      await expect(waitingRows(guest)).toHaveCount(0);
      await expect(
        guest
          .getByRole("status")
          .filter({ hasText: "Stopped retrying comment" }),
      ).toBeVisible();
      await guest.getByRole("button", { name: "Undo" }).click();
      await expect(waitingRows(guest)).toHaveCount(1);
      await expect(light(guest)).toContainText("1 waiting");
    });
  });

  test("is sent once when two tabs of the same link both see the host come back", async ({
    browser,
  }) => {
    await withGuestLink(browser, DESKTOP, async (guest, token) => {
      await openGuestShare(guest, token);
      const away = await hostSends(guest, token, unreachable);
      await writeComment(guest, TEXT);
      await expect(waitingRows(guest)).toHaveCount(1);

      const other = await guest.context().newPage();
      await openGuestShare(other, token);
      await expect(waitingRows(other)).toHaveCount(1);
      await expect(light(other)).toContainText("1 waiting");

      await away.lift();
      const landed = await hostSends(guest, token, (route) => route.continue());
      await Promise.all([deviceBack(guest), deviceBack(other)]);
      await expect
        .poll(async () => (await serverComments(guest, token)).length)
        .toBe(1);
      await expect(waitingRows(guest)).toHaveCount(0);
      await expect(waitingRows(other)).toHaveCount(0);
      await expect(commentRows(other)).toHaveCount(1);
      expect(landed.seen.posts).toBe(1);
      expect(await serverComments(guest, token)).toHaveLength(1);
    });
  });

  test("cannot cancel a comment another tab is sending", async ({
    browser,
  }) => {
    await withGuestLink(browser, DESKTOP, async (guest, token) => {
      await openGuestShare(guest, token);
      const away = await hostSends(guest, token, unreachable);
      await writeComment(guest, TEXT);
      await expect(waitingRows(guest)).toHaveCount(1);

      const other = await guest.context().newPage();
      await openGuestShare(other, token);
      await expect(waitingRows(other)).toHaveCount(1);
      await away.lift();
      let release = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sending = await hostSends(guest, token, async (route) => {
        await hold;
        await route.continue();
      });
      try {
        await deviceBack(guest);
        await expect.poll(() => sending.seen.posts).toBe(1);
        await other
          .getByRole("button", { name: /^Don't send: comment by/ })
          .first()
          .click();
        await expect(
          other
            .getByRole("status")
            .filter({ hasText: "Sending is in progress" }),
        ).toBeVisible();
        await expect(waitingRows(other)).toHaveCount(1);
      } finally {
        release();
      }
      await expect
        .poll(async () => (await serverComments(guest, token)).length)
        .toBe(1);
      await expect(waitingRows(other)).toHaveCount(0);
    });
  });

  test("takes the replies waiting on it along when it is called back", async ({
    browser,
  }) => {
    await withGuestLink(browser, DESKTOP, async (guest, token) => {
      await openGuestShare(guest, token);
      await hostSends(guest, token, unreachable);
      await writeComment(guest, TEXT);
      await expect(waitingRows(guest)).toHaveCount(1);
      await keepReplyTo(guest, token);
      await openGuestShare(guest, token);
      await expect(attention(guest)).toContainText(
        "1 comment and 1 reply waiting to send",
      );

      await guest
        .getByRole("button", { name: /^Don't send: comment by/ })
        .first()
        .click();
      await expect(
        guest
          .getByRole("status")
          .filter({ hasText: "Stopped retrying comment and 1 reply" }),
      ).toBeVisible();
      await expect(attention(guest)).toHaveCount(0);
      expect(await stored(guest, `outbox:${token}`)).toEqual([]);

      await guest.getByRole("button", { name: "Undo" }).click();
      await expect(attention(guest)).toContainText(
        "1 comment and 1 reply waiting to send",
      );
    });
  });

  test("does not keep a late failed POST after the host turns off the link", async ({
    browser,
  }) => {
    await withGuestLink(browser, DESKTOP, async (guest, token, host, path) => {
      await openGuestShare(guest, token);
      let release = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sending = await hostSends(guest, token, async (route) => {
        await hold;
        try {
          await unreachable(route);
        } catch (error) {
          // Ending the link can cancel the intercepted request before release.
          if (
            !(error instanceof Error) ||
            !error.message.includes("Route is already handled")
          )
            throw error;
        }
      });
      try {
        await writeComment(guest, TEXT);
        await expect.poll(() => sending.seen.posts).toBe(1);
        const requestFailed = guest.waitForEvent(
          "requestfailed",
          (request) =>
            request.method() === "POST" && request.url().endsWith("/comments"),
        );
        await revokeLink(host, token, path);
        await deviceBack(guest);
        await expect(guest.getByText(DEAD_TITLE)).toBeVisible();
        await expect(guest.getByText(TEXT)).toBeVisible();
        release();
        await requestFailed;
      } finally {
        release();
      }
      await sending.lift();
      await expect.poll(() => stored(guest, `outbox:${token}`)).toBeNull();
    });
  });

  test("is cleared from the device, and handed back, when the host turns the link off", async ({
    browser,
  }) => {
    await withGuestLink(browser, DESKTOP, async (guest, token, host, path) => {
      await openGuestShare(guest, token);
      const away = await hostSends(guest, token, unreachable);
      await writeComment(guest, TEXT);
      await expect(waitingRows(guest)).toHaveCount(1);
      expect(await stored(guest, `outbox:${token}`)).not.toBeNull();

      await revokeLink(host, token, path);
      await away.lift();
      await deviceBack(guest);
      await expect(guest.getByText(DEAD_TITLE)).toBeVisible();
      await expect(guest.getByText(TEXT)).toBeVisible();
      await expect.poll(() => stored(guest, `outbox:${token}`)).toBeNull();
      expect(await stored(guest, `outbox-returned:${token}`)).toBeNull();
    });
  });
});
