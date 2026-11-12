import {
  type Browser,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { withBrowserPages } from "./twoBrowserPages";

/**
 * The phone guest Listen layout on two touch engines' device profiles (the
 * Playwright build here drives Chromium for both): no text field until the
 * guest taps Comment, the scrubber, Play and Comment always in reach.
 */

const TOUCH_MIN = 44;

const { defaultBrowserType: _iphoneBrowser, ...iPhone } = devices["iPhone 13"];
const { defaultBrowserType: _pixelBrowser, ...pixel } = devices["Pixel 7"];

const PROFILES = [
  { name: "iPhone", device: iPhone },
  { name: "Pixel", device: pixel },
] as const;

const PORTRAITS = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
] as const;

const FOLDED = { width: 667, height: 375 } as const;

type Profile = (typeof PROFILES)[number];
type Size = { width: number; height: number };

/** Two comments and two chapters, so the comments row and the Chapters button exist. */
async function seedReview(host: Page, projectPath: string): Promise<void> {
  const send = (type: string, payload: Record<string, unknown>) =>
    postDocumentCommand(host, "e2e-seed", type, payload, projectPath);
  await send("AddComment", {
    body: "Cut candidate: long pause",
    author: "Dee",
    timeline_start: 5,
  });
  await send("AddComment", {
    body: "Level feels low here",
    author: "Eli",
    timeline_start: 30,
  });
  await send("AddChapter", { time: 0, title: "Cold open" });
  await send("AddChapter", { time: 30, title: "The long way round" });
}

async function withPhoneGuest(
  browser: Browser,
  profile: Profile,
  size: Size,
  role: "commenter" | "viewer",
  run: (guest: Page) => Promise<void>,
): Promise<void> {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [
        {},
        {
          ...profile.device,
          viewport: size,
          screen: size,
          reducedMotion: "reduce",
        },
      ],
      async ([host, guest]) => {
        await openHostShare(host, projectPath);
        await seedReview(host, projectPath);
        const token = await createReviewShare(host, projectPath, role);
        await openGuestShare(guest, token);
        await guest
          .getByRole("button", { name: "Dismiss hint" })
          .tap({ timeout: 2_000 })
          .catch(() => undefined);
        await run(guest);
      },
    );
  });
}

const scrubber = (guest: Page) =>
  guest.getByRole("slider", { name: "Episode overview" });
const commentButton = (guest: Page) =>
  guest.getByRole("button", { name: /^Comment at/ });
const composer = (guest: Page) => guest.locator(".rv-compose");

async function expectNoHorizontalScroll(guest: Page, width: number) {
  await expect
    .poll(() => guest.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

async function expectTouchTarget(control: Locator) {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
}

/** Whether the topmost element at the control's centre is the control itself. */
async function reached(control: Locator): Promise<boolean> {
  return control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    );
    return hit !== null && el.contains(hit);
  });
}

async function expectReached(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect.poll(() => reached(control), { message: "covered" }).toBe(true);
}

for (const profile of PROFILES) {
  for (const size of PORTRAITS) {
    const where = `${profile.name} ${size.width}x${size.height}`;

    test(`a Commenter first sees no text field, and the scrubber, Play and Comment in reach, on ${where}`, async ({
      browser,
    }) => {
      await withPhoneGuest(
        browser,
        profile,
        size,
        "commenter",
        async (guest) => {
          await expect(commentButton(guest)).toBeVisible();
          await expect(guest.getByRole("textbox")).toHaveCount(0);
          const play = guest.getByRole("button", { name: "Play", exact: true });
          await expectReached(scrubber(guest));
          const strip = await guest.locator(".sys-dock-strip").boundingBox();
          expect(strip?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_MIN - 0.5);
          for (const control of [play, commentButton(guest)]) {
            await expectReached(control);
            await expectTouchTarget(control);
          }
          for (const name of [
            "Chapters",
            "Back 15 seconds",
            "Forward 15 seconds",
          ])
            await expectTouchTarget(guest.getByRole("button", { name }));
          await expectNoHorizontalScroll(guest, size.width);
          await expectPageAxeClean(guest);
        },
      );
    });

    test(`Comment, type and Post leave nothing covered, pause for the comment and return focus on ${where}`, async ({
      browser,
    }) => {
      await withPhoneGuest(
        browser,
        profile,
        size,
        "commenter",
        async (guest) => {
          await guest
            .getByRole("button", { name: "Play", exact: true })
            .tap({ timeout: 10_000 });
          await expect(
            guest.getByRole("button", { name: "Pause", exact: true }),
          ).toBeVisible();
          await commentButton(guest).tap({ timeout: 10_000 });
          const field = composer(guest).getByRole("textbox", {
            name: "Comment",
            exact: true,
          });
          await expect(field).toBeFocused();
          await expect(
            guest.getByRole("button", { name: "Play", exact: true }),
          ).toBeVisible();
          await field.fill("Tighten this pause");
          const name = composer(guest).getByRole("textbox", {
            name: "Your name",
          });
          const post = composer(guest).getByRole("button", {
            name: "Post",
            exact: true,
          });
          for (const control of [field, name, post])
            await expectReached(control);
          await expectNoHorizontalScroll(guest, size.width);
          await post.tap({ timeout: 10_000 });
          await expect(composer(guest)).toHaveCount(0);
          await expect(
            guest.getByRole("button", { name: /^Show comments/ }),
          ).toContainText("Comment added at");
          await expect(commentButton(guest)).toBeFocused();
        },
      );
    });

    test(`the Comments sheet lists the comments and a thread keeps its reply field uncovered on ${where}`, async ({
      browser,
    }) => {
      await withPhoneGuest(
        browser,
        profile,
        size,
        "commenter",
        async (guest) => {
          await guest
            .getByRole("button", { name: /^Show comments/ })
            .tap({ timeout: 10_000 });
          const sheet = guest.getByRole("dialog", { name: "Comments" });
          await expect(sheet).toBeVisible();
          await sheet
            .locator(".sys-queue-row")
            .first()
            .getByRole("button")
            .tap({ timeout: 10_000 });
          const reply = guest.getByRole("textbox", { name: /^Reply to/ });
          await expect(reply).toBeVisible();
          await reply.tap({ timeout: 10_000 });
          await expectReached(reply);
          await expectNoHorizontalScroll(guest, size.width);
        },
      );
    });

    test(`the Chapters sheet seeks and closes on ${where}`, async ({
      browser,
    }) => {
      await withPhoneGuest(
        browser,
        profile,
        size,
        "commenter",
        async (guest) => {
          await guest
            .getByRole("button", { name: "Chapters" })
            .tap({ timeout: 10_000 });
          const sheet = guest.getByRole("dialog", { name: "Chapters" });
          await expect(sheet).toBeVisible();
          await sheet.getByRole("button").first().tap({ timeout: 10_000 });
          await expect(sheet).toHaveCount(0);
        },
      );
    });

    test(`a Viewer sees the scrubber and Play but no Comment button on ${where}`, async ({
      browser,
    }) => {
      await withPhoneGuest(browser, profile, size, "viewer", async (guest) => {
        await expectReached(scrubber(guest));
        await expectReached(
          guest.getByRole("button", { name: "Play", exact: true }),
        );
        await expect(commentButton(guest)).toHaveCount(0);
        await expect(guest.getByRole("textbox")).toHaveCount(0);
        await expectNoHorizontalScroll(guest, size.width);
      });
    });
  }

  test(`a selection bar stays clear of the dock and the comments row on ${profile.name} 375x667`, async ({
    browser,
  }) => {
    await withPhoneGuest(
      browser,
      profile,
      { width: 375, height: 667 },
      "commenter",
      async (guest) => {
        await guest
          .locator(".sys-script-word")
          .first()
          .tap({ timeout: 10_000 });
        const bar = guest.getByRole("group", { name: "Selection actions" });
        await expect(bar).toBeVisible();
        const barBox = await bar.boundingBox();
        const dock = await guest.locator(".sys-dock").boundingBox();
        const row = await guest.locator(".gl-row").boundingBox();
        expect(barBox).not.toBeNull();
        expect(dock).not.toBeNull();
        expect(row).not.toBeNull();
        if (!barBox || !dock || !row) return;
        expect(barBox.y + barBox.height).toBeLessThanOrEqual(row.y + 0.5);
        expect(barBox.y + barBox.height).toBeLessThanOrEqual(dock.y + 0.5);
      },
    );
  });

  test(`a short landscape phone keeps the dock to one row under the scrubber on ${profile.name} 667x375`, async ({
    browser,
  }) => {
    await withPhoneGuest(
      browser,
      profile,
      FOLDED,
      "commenter",
      async (guest) => {
        const strip = scrubber(guest);
        await expectReached(strip);
        const play = guest.getByRole("button", { name: "Play", exact: true });
        const comment = commentButton(guest);
        await expectReached(comment);
        await expectReached(play);
        const dockBox = await guest.locator(".sys-dock").boundingBox();
        const playBox = await play.boundingBox();
        const commentBox = await comment.boundingBox();
        expect(playBox && commentBox).toBeTruthy();
        if (!playBox || !commentBox) return;
        expect(dockBox?.height ?? 999).toBeLessThanOrEqual(150);
        const playMiddle = playBox.y + playBox.height / 2;
        expect(playMiddle).toBeGreaterThanOrEqual(commentBox.y);
        expect(playMiddle).toBeLessThanOrEqual(
          commentBox.y + commentBox.height,
        );
        await expectNoHorizontalScroll(guest, FOLDED.width);
      },
    );
  });
}
