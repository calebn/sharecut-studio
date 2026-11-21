import { expect, type Page, type Route, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { SIZES, withGuestLink } from "./guestLink";
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
        guest.getByRole("status").filter({ hasText: "Comment not sent" }),
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
});
