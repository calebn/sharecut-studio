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

const NARROW = [
  { width: 360, height: 800 },
  { width: 340, height: 720 },
  { width: 320, height: 568 },
] as const;

const FOLDED = { width: 667, height: 375 } as const;

async function expectRestsOnDock(guest: Page, sheet: Locator) {
  await expect(sheet).toBeVisible();
  const dock = await guest.locator(".sys-listen-dock").boundingBox();
  const box = await sheet.boundingBox();
  expect(dock && box).toBeTruthy();
  if (!dock || !box) return;
  expect(Math.abs(box.y + box.height - dock.y)).toBeLessThanOrEqual(1);
}

async function expectCommentsReadable(
  guest: Page,
  sheet: Locator,
  min: number,
) {
  const dock = await guest.locator(".sys-listen-dock").boundingBox();
  const header = await sheet.locator(".bottom-sheet-header").boundingBox();
  expect(dock && header).toBeTruthy();
  if (!dock || !header) return;
  const rows = sheet.locator(".sys-queue-row");
  const count = await rows.count();
  let visible = 0;
  for (let i = 0; i < count; i++) {
    const box = await rows.nth(i).boundingBox();
    if (!box) continue;
    expect(box.height).toBeGreaterThanOrEqual(44);
    const text = (await rows.nth(i).innerText()).replace(/\s+/g, " ");
    // The author is the row's avatar: its initial shows, its title names them.
    expect(text).toMatch(/^[DE] /);
    await expect(
      rows.nth(i).locator('[title="Dee"], [title="Eli"]').first(),
    ).toBeVisible();
    expect(text).toMatch(/\d+:\d\d/);
    expect(text).toMatch(/Cut candidate: long pause|Level feels low here/);
    if (
      box.y >= header.y + header.height - 1 &&
      box.y + box.height <= dock.y + 1
    )
      visible++;
  }
  expect(visible).toBeGreaterThanOrEqual(min);
  await expect(sheet.getByRole("group", { name: "Filter" })).toHaveCount(0);
  await expect(sheet.getByRole("group", { name: "Sort" })).toHaveCount(0);
}

type Profile = (typeof PROFILES)[number];
type Size = { width: number; height: number };

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
const commentsRow = (guest: Page) =>
  guest.getByRole("button", { name: /^Show\b.*\bcomments?/ });
const composer = (guest: Page) => guest.locator(".rv-compose");

async function expectDockFits(guest: Page, width: number) {
  const fit = await guest.evaluate(() => {
    const dock = document.querySelector<HTMLElement>(".sys-listen-dock");
    const transport = document.querySelector<HTMLElement>(
      ".sys-listen-dock-transport",
    );
    if (!dock || !transport) return null;
    const style = getComputedStyle(dock);
    const controls = [...transport.querySelectorAll<HTMLElement>("button")]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0);
    const gap = parseFloat(getComputedStyle(transport).columnGap) || 0;
    const used =
      controls.reduce((sum, r) => sum + r.width, 0) +
      gap * (controls.length - 1);
    const box = dock.getBoundingClientRect();
    return {
      count: controls.length,
      free: transport.clientWidth - used,
      scrolls: transport.scrollWidth > transport.clientWidth,
      left: Math.min(...controls.map((r) => r.left)) - box.left,
      right: box.right - Math.max(...controls.map((r) => r.right)),
      padding: parseFloat(style.paddingInlineStart),
    };
  });
  expect(fit).not.toBeNull();
  if (!fit) return;
  expect(fit.count).toBe(5);
  expect(fit.scrolls).toBe(false);
  expect(fit.left).toBeGreaterThanOrEqual(fit.padding - 0.5);
  expect(fit.right).toBeGreaterThanOrEqual(fit.padding - 0.5);
  expect(fit.free).toBeGreaterThanOrEqual(8);
  await expectNoHorizontalScroll(guest, width);
}

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
          const strip = await guest
            .locator(".sys-listen-dock-strip")
            .boundingBox();
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
          await expectDockFits(guest, size.width);
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
          await expect(commentsRow(guest)).toContainText("Comment added at");
          await expect(commentButton(guest)).toBeFocused();
        },
      );
    });

    test(`Comment pauses the episode and Close plays it on from there on ${where}`, async ({
      browser,
    }) => {
      await withPhoneGuest(
        browser,
        profile,
        size,
        "commenter",
        async (guest) => {
          const elapsed = guest.locator(".sys-listen-dock-elapsed");
          await guest
            .getByRole("button", { name: "Play", exact: true })
            .tap({ timeout: 10_000 });
          await expect(elapsed).not.toHaveText(/^0:0[0-2]$/);
          await commentButton(guest).tap({ timeout: 10_000 });
          await expect(
            guest.getByRole("button", { name: "Play", exact: true }),
          ).toBeVisible();
          const pausedAt = await elapsed.textContent();
          await composer(guest)
            .getByRole("button", { name: "Close", exact: true })
            .tap({ timeout: 10_000 });
          await expect(composer(guest)).toHaveCount(0);
          await expect(
            guest.getByRole("button", { name: "Pause", exact: true }),
          ).toBeVisible();
          await expect(elapsed).not.toHaveText(pausedAt ?? "");
          await expect(commentButton(guest)).toBeFocused();
        },
      );
    });

    test(`a selection bar's Comment pauses the episode and Close plays it on on ${where}`, async ({
      browser,
    }) => {
      await withPhoneGuest(
        browser,
        profile,
        size,
        "commenter",
        async (guest) => {
          const elapsed = guest.locator(".sys-listen-dock-elapsed");
          await guest
            .getByRole("button", { name: "Play", exact: true })
            .tap({ timeout: 10_000 });
          await expect(elapsed).not.toHaveText(/^0:0[0-2]$/);
          await guest
            .locator(".sys-script-word")
            .first()
            .tap({ timeout: 10_000 });
          await guest
            .getByRole("group", { name: "Selection actions" })
            .getByRole("button", { name: "Comment" })
            .tap({ timeout: 10_000 });
          await expect(composer(guest)).toBeVisible();
          await expect(
            guest.getByRole("button", { name: "Play", exact: true }),
          ).toBeVisible();
          await composer(guest)
            .getByRole("button", { name: "Close", exact: true })
            .tap({ timeout: 10_000 });
          await expect(
            guest.getByRole("button", { name: "Pause", exact: true }),
          ).toBeVisible();
        },
      );
    });

    test(`text typed, Close and a seek leave the pin chip at the time it was typed at on ${where}`, async ({
      browser,
    }) => {
      await withPhoneGuest(
        browser,
        profile,
        size,
        "commenter",
        async (guest) => {
          const elapsed = guest.locator(".sys-listen-dock-elapsed");
          const chip = () => composer(guest).locator(".sys-composer-chip");
          await guest
            .getByRole("button", { name: "Play", exact: true })
            .tap({ timeout: 10_000 });
          await expect(elapsed).not.toHaveText(/^0:0[0-2]$/);
          await commentButton(guest).tap({ timeout: 10_000 });
          const pinned = (await chip().locator(".sys-mono").innerText()).trim();
          await composer(guest)
            .getByRole("textbox", { name: "Comment", exact: true })
            .fill("too loud here");
          await composer(guest)
            .getByRole("button", { name: "Close", exact: true })
            .tap({ timeout: 10_000 });
          await guest
            .getByRole("button", { name: "Pause", exact: true })
            .tap({ timeout: 10_000 });
          await scrubber(guest).focus();
          await guest.keyboard.press("End");
          await expect(elapsed).not.toHaveText(pinned);
          await commentButton(guest).tap({ timeout: 10_000 });
          await expect(
            composer(guest).getByRole("textbox", {
              name: "Comment",
              exact: true,
            }),
          ).toHaveValue("too loud here");
          await expect(chip().locator(".sys-mono")).toHaveText(pinned);
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
          await commentsRow(guest).tap({ timeout: 10_000 });
          const sheet = guest.getByRole("dialog", { name: "Comments" });
          await expectRestsOnDock(guest, sheet);
          await expectCommentsReadable(guest, sheet, 2);
          await sheet
            .locator(".sys-queue-row")
            .first()
            .getByRole("button")
            .tap({ timeout: 10_000 });
          const thread = guest.getByRole("dialog", { name: /^Comment from/ });
          const back = thread.getByRole("button", { name: "Back to comments" });
          await expect(back).toBeVisible();
          const backBox = await back.boundingBox();
          expect(backBox?.width ?? 0).toBeGreaterThanOrEqual(44);
          expect(backBox?.height ?? 0).toBeGreaterThanOrEqual(44);
          await expect(thread.getByRole("heading")).toHaveCount(1);
          await expectRestsOnDock(guest, thread);
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
          await expectRestsOnDock(guest, sheet);
          await sheet
            .getByRole("button", { name: /The long way round/ })
            .tap({ timeout: 10_000 });
          await expect(sheet).toHaveCount(0);
          await expect(guest.locator(".sys-listen-dock-elapsed")).toHaveText(
            "0:30",
          );
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

    test(`a Viewer reads the Script in the middle, read only, with Chapters in the dock, and a thread without a reply field on ${where}`, async ({
      browser,
    }) => {
      await withPhoneGuest(browser, profile, size, "viewer", async (guest) => {
        const script = guest.locator(".stage-host-guest-script");
        await expect(script).toContainText("Read only");
        const elapsed = guest.locator(".sys-listen-dock-elapsed");
        const before = await elapsed.textContent();
        await script
          .locator(".sys-script-word")
          .nth(8)
          .tap({ timeout: 10_000 });
        await expect(elapsed).not.toHaveText(before ?? "");
        await expect(script.locator("[data-selected]")).toHaveCount(0);
        await expect(
          guest.getByRole("group", { name: "Selection actions" }),
        ).toHaveCount(0);
        await expect(
          guest.getByRole("button", { name: "Chapters" }),
        ).toBeVisible();
        await commentsRow(guest).tap({ timeout: 10_000 });
        const sheet = guest.getByRole("dialog", { name: "Comments" });
        await sheet
          .locator(".sys-queue-row")
          .first()
          .getByRole("button")
          .tap({ timeout: 10_000 });
        const thread = guest.getByRole("dialog", { name: /^Comment from/ });
        await expect(thread).toBeVisible();
        await expect(thread.getByRole("textbox")).toHaveCount(0);
        await expect(guest.getByRole("textbox")).toHaveCount(0);
      });
    });
  }

  for (const size of NARROW) {
    test(`the dock fits with room to spare and 44 px targets on ${profile.name} ${size.width}x${size.height}`, async ({
      browser,
    }) => {
      await withPhoneGuest(
        browser,
        profile,
        size,
        "commenter",
        async (guest) => {
          await expectDockFits(guest, size.width);
          for (const control of [
            guest.getByRole("button", { name: "Play", exact: true }),
            commentButton(guest),
            guest.getByRole("button", { name: "Chapters" }),
            guest.getByRole("button", { name: "Back 15 seconds" }),
            guest.getByRole("button", { name: "Forward 15 seconds" }),
          ]) {
            await expectReached(control);
            await expectTouchTarget(control);
          }
        },
      );
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
        const dock = await guest.locator(".sys-listen-dock").boundingBox();
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
        const dockBox = await guest.locator(".sys-listen-dock").boundingBox();
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

  test(`a short landscape phone keeps Chapters in reach on ${profile.name} 667x375`, async ({
    browser,
  }) => {
    await withPhoneGuest(
      browser,
      profile,
      FOLDED,
      "commenter",
      async (guest) => {
        const chapters = guest.getByRole("button", { name: "Chapters" });
        await expectReached(chapters);
        await expectTouchTarget(chapters);
        await expectNoHorizontalScroll(guest, FOLDED.width);
        await chapters.tap({ timeout: 10_000 });
        await expect(
          guest.getByRole("dialog", { name: "Chapters" }),
        ).toBeVisible();
      },
    );
  });

  test(`the Comments sheet rests on the folded dock on ${profile.name} 667x375`, async ({
    browser,
  }) => {
    await withPhoneGuest(
      browser,
      profile,
      FOLDED,
      "commenter",
      async (guest) => {
        await commentsRow(guest).tap({ timeout: 10_000 });
        const comments = guest.getByRole("dialog", { name: "Comments" });
        await expectRestsOnDock(guest, comments);
        await expectCommentsReadable(guest, comments, 1);
      },
    );
  });
}

test("a desktop guest whose queue holds a comment and a suggestion keeps the filter and the sort", async ({
  browser,
}) => {
  await withPhoneGuest(
    browser,
    { name: "Desktop", device: {} } as unknown as Profile,
    { width: 1280, height: 800 },
    "commenter",
    async (guest) => {
      await guest
        .locator(".sys-script-word")
        .first()
        .click({ timeout: 10_000 });
      await guest
        .getByRole("group", { name: /actions$/ })
        .getByRole("button", { name: /^Suggest/ })
        .first()
        .click({ timeout: 10_000 });
      await expect(guest.getByRole("group", { name: "Filter" })).toBeVisible();
      await expect(guest.getByRole("group", { name: "Sort" })).toBeVisible();
    },
  );
});
