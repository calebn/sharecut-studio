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
import { runPaletteCommand } from "./stageNav";
import { parseTimecodeSec } from "./timecode";
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

type Profile = { name: string; device: typeof iPhone };
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
  role: "commenter" | "viewer" | "editor",
  run: (guest: Page) => Promise<void>,
  colorScheme: "light" | "dark" = "light",
  screen: Size = size,
): Promise<void> {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [
        {},
        {
          ...profile.device,
          viewport: size,
          screen,
          reducedMotion: "reduce",
          colorScheme,
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

    test(`Comment pauses playback and Post resumes it, returns focus and leaves nothing covered on ${where}`, async ({
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
          await expectPageAxeClean(guest);
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
          const elapsed = guest.locator(".sys-listen-dock-elapsed");
          const pausedAt = parseTimecodeSec(await elapsed.innerText());
          await post.tap({ timeout: 10_000 });
          await expect(composer(guest)).toHaveCount(0);
          await expect(commentsRow(guest)).toContainText("Comment added at");
          await expect(
            guest.getByRole("button", { name: "Pause", exact: true }),
          ).toBeVisible();
          await expect
            .poll(async () => parseTimecodeSec(await elapsed.innerText()))
            .toBeGreaterThan(pausedAt);
          await expectPageAxeClean(guest);
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
          await expectPageAxeClean(guest);
          await sheet
            .locator(".sys-queue-row")
            .first()
            .getByRole("button")
            .tap({ timeout: 10_000 });
          const thread = guest.getByRole("dialog", { name: /^Comment from/ });
          await expectPageAxeClean(guest);
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
          await expectPageAxeClean(guest);
          await sheet
            .getByRole("button", { name: /The long way round/ })
            .tap({ timeout: 10_000 });
          await expect(sheet).toHaveCount(0);
          await expect(guest.locator(".sys-listen-dock-elapsed")).toHaveText(
            "0:30",
          );
          // The row now shows the comment being heard.
          await expect(commentsRow(guest)).toContainText(
            "Level feels low here",
          );
          await expectPageAxeClean(guest);
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
        await expectPageAxeClean(guest);
      });
    });

    test(`a Viewer reads the Script in the middle, read only, with Chapters in the dock, and a thread without a reply field on ${where}`, async ({
      browser,
    }) => {
      await withPhoneGuest(browser, profile, size, "viewer", async (guest) => {
        const script = guest.locator(".stage-host-guest-script");
        await expect(script).toContainText("Read only");
        await expect(script.locator(".sys-script-header")).toHaveCount(0);
        await expect(
          script.getByRole("button", { name: "Follow the playhead" }),
        ).toHaveCount(0);
        const caption = await script
          .locator(".sys-script-caption")
          .boundingBox();
        expect(caption?.height ?? 999).toBeLessThanOrEqual(32);
        await expect(
          script.getByRole("region", { name: "Script" }),
        ).toHaveAccessibleDescription("Read only");
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

  test(`an Editor on a short landscape phone can still comment from the bar on ${profile.name} 667x375`, async ({
    browser,
  }) => {
    await withPhoneGuest(browser, profile, FOLDED, "editor", async (guest) => {
      const comment = guest.getByRole("button", {
        name: "Comment",
        exact: true,
      });
      await expectReached(comment);
      const box = await comment.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(TOUCH_MIN);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_MIN);
      await guest
        .getByRole("button", { name: "Play", exact: true })
        .tap({ timeout: 10_000 });
      const pause = guest.getByRole("button", { name: "Pause", exact: true });
      await expect(pause).toBeVisible();
      await comment.tap({ timeout: 10_000 });
      await expect(composer(guest)).toBeVisible();
      await expect(pause).toBeVisible();
      await expectNoHorizontalScroll(guest, FOLDED.width);
    });
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
        await expectPageAxeClean(guest);
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
        await expectPageAxeClean(guest);
      },
    );
  });

  test(`a Commenter on a dark phone has no axe violations at first load and with the Comments sheet open on ${profile.name} 390x844`, async ({
    browser,
  }) => {
    await withPhoneGuest(
      browser,
      profile,
      PORTRAITS[0],
      "commenter",
      async (guest) => {
        await expectPageAxeClean(guest);
        await commentsRow(guest).tap({ timeout: 10_000 });
        await expect(
          guest.getByRole("dialog", { name: "Comments" }),
        ).toBeVisible();
        await expectPageAxeClean(guest);
      },
      "dark",
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

test("Pause and return while composing stops playback after the comment closes", async ({
  browser,
}) => {
  await withPhoneGuest(
    browser,
    PROFILES[0],
    PORTRAITS[0],
    "commenter",
    async (guest) => {
      const play = guest.getByRole("button", { name: "Play", exact: true });
      const pause = guest.getByRole("button", { name: "Pause", exact: true });
      await play.tap();
      await expect(pause).toBeVisible();
      const elapsed = guest.locator(".sys-listen-dock-elapsed");
      await expect
        .poll(async () => parseTimecodeSec(await elapsed.innerText()))
        .toBeGreaterThan(0);
      await commentButton(guest).tap();
      await expect(composer(guest)).toBeVisible();
      await expect(play).toBeVisible();
      await runPaletteCommand(guest, "Pause and return");
      await expect
        .poll(async () => parseTimecodeSec(await elapsed.innerText()))
        .toBe(0);
      await composer(guest)
        .getByRole("button", { name: "Close", exact: true })
        .tap();
      await expect(composer(guest)).toHaveCount(0);
      await expect(play).toBeVisible();
    },
  );
});

const LANDSCAPES = [
  { profile: PROFILES[0], size: { width: 844, height: 390 } },
  { profile: PROFILES[1], size: { width: 915, height: 412 } },
] as const;

const TABLETS = [
  { width: 1133, height: 744 },
  { width: 1180, height: 820 },
] as const;

const TOUCH_TABLET: Profile = { name: "touch tablet", device: iPhone };

const shellOf = (guest: Page) =>
  guest.evaluate(() => ({
    shell: document.documentElement.dataset.shell,
    player: document.documentElement.dataset.player ?? null,
    dock: document.querySelectorAll(".sys-listen-dock").length,
  }));

for (const { profile, size } of LANDSCAPES) {
  const where = `${profile.name} ${size.width}x${size.height} held sideways`;

  test(`a Commenter gets the Listen dock and no text field until Comment on ${where}`, async ({
    browser,
  }) => {
    await withPhoneGuest(browser, profile, size, "commenter", async (guest) => {
      await expect(guest.locator(".sys-listen-dock")).toBeVisible();
      expect(await shellOf(guest)).toMatchObject({
        player: "dock",
        dock: 1,
      });
      await expect(commentButton(guest)).toBeVisible();
      await expect(guest.getByRole("textbox")).toHaveCount(0);
      await expectNoHorizontalScroll(guest, size.width);
    });
  });

  test(`a Viewer gets the Listen dock without a Comment button on ${where}`, async ({
    browser,
  }) => {
    await withPhoneGuest(browser, profile, size, "viewer", async (guest) => {
      await expect(guest.locator(".sys-listen-dock")).toBeVisible();
      await expect(guest.getByRole("textbox")).toHaveCount(0);
      await expect(commentButton(guest)).toHaveCount(0);
    });
  });

  test(`Comment pauses playback and opens the composer on ${where}`, async ({
    browser,
  }) => {
    await withPhoneGuest(browser, profile, size, "commenter", async (guest) => {
      await guest
        .getByRole("button", { name: "Play", exact: true })
        .tap({ timeout: 10_000 });
      await expect(
        guest.getByRole("button", { name: "Pause", exact: true }),
      ).toBeVisible();
      await commentButton(guest).tap({ timeout: 10_000 });
      await expect(
        composer(guest).getByRole("textbox", { name: "Comment", exact: true }),
      ).toBeFocused();
      await expect(
        guest.getByRole("button", { name: "Play", exact: true }),
      ).toBeVisible();
    });
  });

  test(`rotating with a typed draft keeps the draft and does not pause on ${where}`, async ({
    browser,
  }) => {
    await withPhoneGuest(browser, profile, size, "commenter", async (guest) => {
      await commentButton(guest).tap({ timeout: 10_000 });
      const field = composer(guest).getByRole("textbox", {
        name: "Comment",
        exact: true,
      });
      await field.fill("Tighten this pause");
      await guest.setViewportSize({ width: size.height, height: size.width });
      await expect(field).toHaveValue("Tighten this pause");
      await guest
        .getByRole("button", { name: "Play", exact: true })
        .tap({ timeout: 10_000 });
      const pause = guest.getByRole("button", { name: "Pause", exact: true });
      await expect(pause).toBeVisible();
      await guest.setViewportSize(size);
      await expect(field).toHaveValue("Tighten this pause");
      await expect(pause).toBeVisible();
    });
  });
}

/**
 * What of `el` shows: the share of a 5 x 5 grid of points inside its box that
 * is in the viewport and hit-tests to the element itself, so a clip by an
 * ancestor, the dock or the screen edge all count (an overflow walk would
 * wrongly clip a fixed element).
 */
async function visibleShare(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let hit = 0;
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        const x = r.left + 2 + ((r.width - 4) * i) / 4;
        const y = r.top + 2 + ((r.height - 4) * j) / 4;
        const at = document.elementFromPoint(x, y);
        if (at && el.contains(at)) hit++;
      }
    }
    return hit / 25;
  });
}

const HELD = { width: 844, height: 390 } as const;

test("held sideways at 844x390 the sheets and toast rest on the Listen dock, not on tablet chrome", async ({
  browser,
}) => {
  await withPhoneGuest(
    browser,
    PROFILES[0],
    HELD,
    "commenter",
    async (guest) => {
      expect(await shellOf(guest)).toMatchObject({
        shell: "tablet",
        player: "dock",
      });
      const dock = guest.locator(".sys-listen-dock");
      const box = await dock.boundingBox();
      expect(box).not.toBeNull();
      // The dock is fixed to the bottom edge, in view.
      expect(
        Math.abs((box?.y ?? 0) + (box?.height ?? 0) - HELD.height),
      ).toBeLessThanOrEqual(1);
      // The reserve the sheets and the toast rest on is the dock's own height
      // (stage-frame.css keys it on data-player, not on the phone shell).
      const reserve = await guest.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:fixed;visibility:hidden;inline-size:1px;block-size:var(--frame-bottom-chrome)";
        document.body.append(probe);
        const h = probe.getBoundingClientRect().height;
        probe.remove();
        return h;
      });
      expect(reserve).toBeGreaterThanOrEqual((box?.height ?? 0) - 1);
      expect(reserve).toBeLessThanOrEqual((box?.height ?? 0) + 2);
      await commentsRow(guest).tap({ timeout: 10_000 });
      await expectRestsOnDock(
        guest,
        guest.getByRole("dialog", { name: "Comments" }),
      );
    },
  );
});

test("a handheld's window too tall to fold still rests its sheets on the dock, not on the tablet Player", async ({
  browser,
}) => {
  // A 412x915 phone screen with a 820x640 window: the tablet shell, a frame
  // that is not short, so only the unfolded dock rule (stage-frame.css keyed
  // on data-player, not on the phone shell) sets the reserve.
  await withPhoneGuest(
    browser,
    PROFILES[1],
    { width: 820, height: 640 },
    "commenter",
    async (guest) => {
      expect(await shellOf(guest)).toMatchObject({
        shell: "tablet",
        player: "dock",
      });
      expect(
        await guest.evaluate(
          () => "frameShort" in document.documentElement.dataset,
        ),
      ).toBe(false);
      const dockBox = await guest.locator(".sys-listen-dock").boundingBox();
      const reserve = await guest.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:fixed;visibility:hidden;inline-size:1px;block-size:var(--frame-bottom-chrome)";
        document.body.append(probe);
        const h = probe.getBoundingClientRect().height;
        probe.remove();
        return h;
      });
      expect(reserve).toBeGreaterThanOrEqual((dockBox?.height ?? 0) - 1);
      expect(reserve).toBeLessThanOrEqual((dockBox?.height ?? 0) + 2);
      await commentsRow(guest).tap({ timeout: 10_000 });
      await expectRestsOnDock(
        guest,
        guest.getByRole("dialog", { name: "Comments" }),
      );
    },
    "light",
    { width: 412, height: 915 },
  );
});

test("held sideways at 844x390 the posted toast clears the Listen dock", async ({
  browser,
}) => {
  await withPhoneGuest(
    browser,
    PROFILES[0],
    HELD,
    "commenter",
    async (guest) => {
      await commentButton(guest).tap({ timeout: 10_000 });
      await composer(guest)
        .getByRole("textbox", { name: "Comment", exact: true })
        .fill("Loved the intro");
      await composer(guest)
        .getByRole("textbox", { name: "Your name" })
        .fill("Riley");
      await composer(guest)
        .getByRole("button", { name: "Post", exact: true })
        .tap();
      const toast = guest.locator(".ui-toast-region--app .ui-toast");
      await expect(toast).toContainText("Comment posted at");
      await expect(toast).toBeInViewport({ ratio: 1 });
      await guest.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const toastBox = await toast.boundingBox();
      const dockBox = await guest.locator(".sys-listen-dock").boundingBox();
      expect(toastBox && dockBox).toBeTruthy();
      if (!toastBox || !dockBox) return;
      expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(dockBox.y + 1);
    },
  );
});

test("held sideways at 844x390 a long-pressed word's selection bar is not clipped", async ({
  browser,
}) => {
  await withPhoneGuest(
    browser,
    PROFILES[0],
    HELD,
    "commenter",
    async (guest) => {
      // The Listen layout gets the phone Script (17/28 type), not the desktop one.
      expect(
        await guest
          .locator(".sys-script-word")
          .first()
          .evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight)),
      ).toBeGreaterThan(27);
      await guest.locator(".sys-script-word").first().tap({ timeout: 10_000 });
      const bar = guest.getByRole("group", { name: "Selection actions" });
      await expect(bar).toBeVisible();
      expect(await visibleShare(bar)).toBeGreaterThan(0.99);
      expect(await reached(bar.getByRole("button", { name: "Comment" }))).toBe(
        true,
      );
      const barBox = await bar.boundingBox();
      const dockBox = await guest.locator(".sys-listen-dock").boundingBox();
      expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeLessThanOrEqual(
        (dockBox?.y ?? 0) + 1,
      );
    },
  );
});

for (const size of [
  { width: 740, height: 360 },
  { width: 800, height: 360 },
] as const) {
  test(`the Listen layout fits at ${size.width}x${size.height} with the composer open`, async ({
    browser,
  }) => {
    await withPhoneGuest(
      browser,
      PROFILES[1],
      size,
      "commenter",
      async (guest) => {
        expect(await shellOf(guest)).toMatchObject({ player: "dock" });
        await expect(scrubber(guest)).toBeVisible();
        await expectNoHorizontalScroll(guest, size.width);
        await expectTouchTarget(commentButton(guest));
        await commentButton(guest).tap({ timeout: 10_000 });
        const field = composer(guest).getByRole("textbox", {
          name: "Comment",
          exact: true,
        });
        await expect(field).toBeFocused();
        for (const control of [
          field,
          composer(guest).getByRole("textbox", { name: "Your name" }),
          composer(guest).getByRole("button", { name: "Post", exact: true }),
        ]) {
          const box = await control.boundingBox();
          const dockBox = await guest.locator(".sys-listen-dock").boundingBox();
          expect(box && dockBox).toBeTruthy();
          expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
          expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
            (dockBox?.y ?? 0) + 1,
          );
          expect(await reached(control)).toBe(true);
        }
        await expectNoHorizontalScroll(guest, size.width);
      },
    );
  });
}

for (const size of TABLETS) {
  test(`a Commenter on a ${size.width}x${size.height} tablet keeps the tablet layout and Comment leaves playback alone`, async ({
    browser,
  }) => {
    await withPhoneGuest(
      browser,
      TOUCH_TABLET,
      size,
      "commenter",
      async (guest) => {
        expect(await shellOf(guest)).toEqual({
          shell: "tablet",
          player: null,
          dock: 0,
        });
        await guest
          .getByRole("button", { name: "Play", exact: true })
          .first()
          .click({ timeout: 10_000 });
        const pause = guest.getByRole("button", { name: "Pause", exact: true });
        await expect(pause).toBeVisible();
        await guest
          .getByRole("button", { name: "Comment", exact: true })
          .first()
          .click({ timeout: 10_000 });
        await expect(pause).toBeVisible();
      },
    );
  });
}

for (const role of ["editor"] as const) {
  test(`an ${role} held sideways at 844x390 keeps the tablet shell without the dock`, async ({
    browser,
  }) => {
    await withPhoneGuest(
      browser,
      PROFILES[0],
      LANDSCAPES[0].size,
      role,
      async (guest) => {
        expect(await shellOf(guest)).toEqual({
          shell: "tablet",
          player: null,
          dock: 0,
        });
      },
    );
  });
}

test("the host held sideways at 844x390 keeps the tablet shell without the dock", async ({
  browser,
}) => {
  await withShareableProject(async (projectPath) => {
    await withBrowserPages(
      browser,
      [
        {
          ...PROFILES[0].device,
          viewport: LANDSCAPES[0].size,
          screen: LANDSCAPES[0].size,
        },
      ],
      async ([host]) => {
        await openHostShare(host!, projectPath);
        expect(await shellOf(host!)).toEqual({
          shell: "tablet",
          player: null,
          dock: 0,
        });
      },
    );
  });
});
