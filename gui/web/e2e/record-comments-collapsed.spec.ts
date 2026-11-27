import { expect, type Page, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import {
  ensureHostRecordCommand,
  hostRecordSnapshot,
  joinAsGuest,
  markSharecutE2e,
  openRoomComments,
} from "./recordRoom";
import { inRoom, LAPTOP, phoneAt } from "./recordRoomPages";
import { setTheme } from "./theme";

/**
 * #4660: on the host phone the Comments sheet starts collapsed to its peek bar
 * during a take; the peek counts comments by others and pulses once for each
 * new one; one tap opens the sheet and it stays open.
 */

test.use({ launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] } });

const panel = (page: Page) => page.getByRole("dialog", { name: /^Comments/ });
const peek = (page: Page) => page.locator(".sys-room-view-peek");
const badge = (page: Page) => peek(page).locator(".sys-dock-badge--inline");
const dock = (page: Page) => page.locator(".sys-room-view-dock");
const notices = (page: Page) => page.locator(".stage-host-record-notices");

type Room = Parameters<Parameters<typeof inRoom>[2]>[0];

async function expectCollapsed(page: Page) {
  await expect(peek(page)).toHaveAttribute("aria-expanded", "false");
  await expect(panel(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      mode: document.documentElement.getAttribute("data-room-sheet"),
      bottom: document.documentElement.style.getPropertyValue(
        "--room-sheet-bottom",
      ),
    })),
  ).toEqual({ mode: null, bottom: "" });
}

async function expectOpen(page: Page) {
  await expect(peek(page)).toHaveAttribute("aria-expanded", "true");
  await expect(panel(page)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.getAttribute("data-room-sheet"),
      ),
    )
    .toBe("bottom");
}

async function commentCount(host: Page, projectPath: string) {
  return (await hostRecordSnapshot(host, projectPath)).comments?.length ?? 0;
}

async function guestSays(guest: Page, text: string) {
  const comments = await openRoomComments(guest);
  await comments.getByRole("textbox", { name: "Add a comment" }).fill(text);
  await comments.getByRole("button", { name: "Post" }).click();
  await expect(
    comments.getByRole("listitem").filter({ hasText: text }),
  ).toBeVisible();
}

async function startTake({ host, guest, projectPath, room }: Room) {
  await joinAsGuest(guest, room.guest.token, "Ava");
  await ensureHostRecordCommand(host, projectPath, "Start", "recording");
  await expect(peek(host)).toBeVisible();
}

async function closeSheet(page: Page) {
  await panel(page).getByRole("button", { name: "Close" }).tap();
  await expect(panel(page)).toHaveCount(0);
}

test.describe("host phone, collapsed during a take", () => {
  test("390x844: collapsed at take start, counted and pulsed, one tap opens it and it stays open", async ({
    browser,
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: phoneAt(390), guest: LAPTOP },
      async (ctx) => {
        const { host, guest, projectPath } = ctx;
        await joinAsGuest(guest, ctx.room.guest.token, "Ava");
        await expectOpen(host);
        await ensureHostRecordCommand(host, projectPath, "Start", "recording");
        await expectCollapsed(host);
        await expect(badge(host)).toHaveCount(0);

        await expect(notices(host)).toContainText(
          "Recording in full quality on this device.",
        );
        const announced = async () =>
          (await notices(host).innerText())
            .replace("Hearing the room.", "")
            .trim();
        const noticesBefore = await announced();
        await guestSays(guest, "one");
        await expect(badge(host)).toHaveText("1 unread");
        await expect(badge(host)).toHaveAttribute("data-pulse", "");
        await expect(peek(host)).toHaveAccessibleName(/ 1 unread$/);
        await badge(host).evaluate((el) => {
          (el as unknown as { stale: boolean }).stale = true;
        });

        await guestSays(guest, "two");
        await expect(badge(host)).toHaveText("2 unread");
        await expect(peek(host)).toHaveAccessibleName(/ 2 unread$/);
        expect(
          await badge(host).evaluate((el) => "stale" in el),
          "a new badge element restarts the pulse",
        ).toBe(false);
        expect(await announced(), "an arriving comment is not announced").toBe(
          noticesBefore,
        );
        const before = await commentCount(host, projectPath);
        await guest.keyboard.press("m");
        await expect
          .poll(() => commentCount(host, projectPath))
          .toBe(before + 1);
        await host.keyboard.press("c");
        await expect
          .poll(() => commentCount(host, projectPath))
          .toBe(before + 2);
        await expect(badge(host)).toHaveText("2 unread");
        await peek(host).tap();
        await expectOpen(host);
        await expect(badge(host)).toHaveCount(0);
        const composer = panel(host).getByRole("textbox", {
          name: "Add a comment",
        });
        await composer.fill("host says");
        await panel(host).getByRole("button", { name: "Post" }).tap();
        await guestSays(guest, "three");
        await expect(
          panel(host).getByRole("listitem").filter({ hasText: "three" }),
        ).toBeVisible();
        await expect(badge(host)).toHaveCount(0);
        await expect(peek(host).locator("[data-pulse]")).toHaveCount(0);
        await closeSheet(host);
        await expectCollapsed(host);
        await expect(badge(host)).toHaveCount(0);
        await guestSays(guest, "four");
        await expect(badge(host)).toHaveText("1 unread");
        await peek(host).tap();
        await expectOpen(host);
        await ensureHostRecordCommand(host, projectPath, "Stop", "stopped");
        await expectOpen(host);
        await ensureHostRecordCommand(host, projectPath, "Start", "recording");
        await expectOpen(host);
        await host
          .getByRole("button", { name: "Pause take", exact: true })
          .tap();
        await expect(
          host.getByRole("button", { name: "Resume recording" }),
        ).toBeVisible();
        await expectOpen(host);
        await host.getByRole("button", { name: "Resume recording" }).tap();
        await expectOpen(host);
      },
    );
  });

  test("on the Takes tab a comment is not read: no badge or pulse until the sheet closes, then a quiet badge", async ({
    browser,
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: phoneAt(390), guest: LAPTOP },
      async (ctx) => {
        const { host, guest } = ctx;
        await startTake(ctx);
        await peek(host).tap();
        await expectOpen(host);
        await panel(host).getByRole("tab", { name: "Takes" }).tap();
        await guestSays(guest, "while on takes");
        await expect(badge(host)).toHaveCount(0);
        await expect(peek(host).locator("[data-pulse]")).toHaveCount(0);
        await closeSheet(host);
        await expect(badge(host)).toHaveText("1 unread");
        await expect(peek(host).locator("[data-pulse]")).toHaveCount(0);
        // Reopening shows the Comments tab, which reads them.
        await peek(host).tap();
        await expect(
          panel(host).getByRole("tab", { name: "Comments" }),
        ).toHaveAttribute("aria-selected", "true");
        await closeSheet(host);
        await expect(badge(host)).toHaveCount(0);
      },
    );
  });

  test("reduced motion has no pulse and still counts; no preference pulses", async ({
    browser,
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: { ...phoneAt(390), reducedMotion: "reduce" }, guest: LAPTOP },
      async (ctx) => {
        const { host, guest } = ctx;
        await startTake(ctx);
        const animation = () =>
          badge(host).evaluate((el) => getComputedStyle(el).animationName);
        await guestSays(guest, "one");
        await expect(badge(host)).toHaveText("1 unread");
        expect(await animation()).toBe("none");
        await guestSays(guest, "two");
        await expect(badge(host)).toHaveText("2 unread");
        expect(await animation()).toBe("none");
        await host.emulateMedia({ reducedMotion: "no-preference" });
        await expect.poll(animation).toBe("room-peek-badge-pulse");
      },
    );
  });

  test("a reload mid-take comes back collapsed and does not count the comments already there", async ({
    browser,
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: phoneAt(390), guest: LAPTOP },
      async (ctx) => {
        const { host, guest } = ctx;
        await startTake(ctx);
        await guestSays(guest, "before the reload");
        await expect(badge(host)).toHaveText("1 unread");
        await host.reload();
        await expect(peek(host)).toBeVisible();
        await expectCollapsed(host);
        await expect(peek(host)).toContainText("before the reload");
        await expect(badge(host)).toHaveCount(0);
        await guestSays(guest, "after the reload");
        await expect(badge(host)).toHaveText("1 unread");
      },
    );
  });

  for (const [width, height] of [
    [390, 844],
    [667, 375],
    [320, 568],
  ] as const) {
    test(`${width}x${height}${width > height ? " landscape, bottom dock on a host phone" : ""}: a comment arriving moves neither the peek, the dock nor the tile grid`, async ({
      browser,
    }) => {
      test.slow();
      await inRoom(
        browser,
        { host: phoneAt(width, height), guest: LAPTOP },
        async (ctx) => {
          const { host, guest } = ctx;
          await startTake(ctx);
          await expectCollapsed(host);
          const rects = () =>
            host.evaluate(() => {
              const box = (selector: string) => {
                const r = document
                  .querySelector(selector)
                  ?.getBoundingClientRect();
                return r
                  ? {
                      top: r.top,
                      bottom: r.bottom,
                      left: r.left,
                      right: r.right,
                    }
                  : null;
              };
              return {
                peek: box(".sys-room-view-peek"),
                dock: box(".sys-room-view-dock"),
                grid: box(".sys-room-view-grid"),
              };
            });
          const before = await rects();
          await guestSays(
            guest,
            "a long comment that has to truncate in the peek bar instead of pushing past its edge or wrapping",
          );
          await expect(badge(host)).toHaveText("1 unread");
          expect(await rects()).toEqual(before);
          expect(
            await peek(host).evaluate((el) => el.scrollWidth <= el.clientWidth),
            "the peek truncates its text",
          ).toBe(true);
          expect(
            await host.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          const tile = host.locator(".sys-room-tile").first();
          await expect(tile).toBeInViewport();
          const peekBox = await peek(host).boundingBox();
          expect(peekBox?.height).toBeGreaterThanOrEqual(44);
        },
      );
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`390x844 ${theme}: axe clean with the badge showing`, async ({
      browser,
    }) => {
      test.slow();
      await inRoom(
        browser,
        { host: { ...phoneAt(390), reducedMotion: "reduce" }, guest: LAPTOP },
        async (ctx) => {
          const { host, guest } = ctx;
          await startTake(ctx);
          await setTheme(host, theme);
          await guestSays(guest, "axe");
          await expect(badge(host)).toHaveText("1 unread");
          await expectReadingSurfaceAxeClean(host);
        },
      );
    });
  }
});

test.describe("guard: other seats", () => {
  test("a guest phone shows no badge for a comment, and a laptop host keeps the open rail", async ({
    browser,
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: LAPTOP, guest: phoneAt(390) },
      async ({ host, guest, projectPath, room }) => {
        // Another guest joins first, so the phone guest has someone else's marker to see.
        const context = await browser.newContext(LAPTOP);
        try {
          const bea = await context.newPage();
          await markSharecutE2e(bea);
          await joinAsGuest(bea, room.guest.token, "Bea");
          await joinAsGuest(guest, room.guest.token, "Ava");
          await ensureHostRecordCommand(
            host,
            projectPath,
            "Start",
            "recording",
          );
          // A guest's text comment reaches the host only; a marker reaches the guests.
          await openRoomComments(bea);
          await bea.evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
          });
          await bea.keyboard.press("m");
          await expect(peek(guest)).toContainText("Marker");
        } finally {
          await context.close();
        }
        await expect(host.locator(".sys-room-view-rail")).toBeVisible();
        await expect(peek(host)).toHaveCount(0);
        await expect(peek(guest)).toBeVisible();
        await expect(panel(guest)).toHaveCount(0);
        await expect(badge(guest)).toHaveCount(0);
        await expect(peek(guest).locator("[data-pulse]")).toHaveCount(0);
        await expect(host.locator(".sys-dock-badge--inline")).toHaveCount(0);
        expect(
          await host.evaluate(() =>
            document.documentElement.getAttribute("data-room-sheet"),
          ),
        ).toBeNull();
        await expect(dock(guest)).toBeVisible();
      },
    );
  });
});
