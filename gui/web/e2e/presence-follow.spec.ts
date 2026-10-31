import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { clickHTMLElement } from "./domClick";
import {
  followUntilBannerVisible,
  openPeopleMenu,
  peopleButton,
  waitForFollowBanner,
} from "./followBanner";
import { scrollTimelineBy } from "./scroll";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import {
  type Audition,
  goToStage,
  openPanel,
  phone,
  setAudition,
} from "./stageNav";
import { zoomTimelineIn } from "./timelineZoom";
import { withTwoBrowserPages } from "./twoBrowserPages";

const AUDITION_NAMES: Record<Audition, string> = {
  mix: "Full mix",
  fx: "Without mix processing",
  raw: "Original",
};
const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 820, height: 1180 };
const PHONE = { width: 390, height: 844 };
/** Matches the Storybook `recordMobileViewport` width used by Templates/FollowBanner PhoneLongName. */
const NARROW_PHONE = { width: 360, height: 800 };
async function playerTimecode(page: Page): Promise<string> {
  const now = page.locator(".stage-frame-player .sys-player-now").first();
  return ((await now.textContent()) ?? "").trim();
}

/** Shared GUI process keeps leftover roster entries; prove the peer is this leader. */
async function seekLeaderPlayhead(leader: Page): Promise<string> {
  await phone.showTimeline(leader);
  const ruler = leader.getByRole("slider", { name: "Timeline position" });
  await expect(ruler).toBeVisible();
  await ruler.focus();
  await ruler.press("Home");
  await expect.poll(() => playerTimecode(leader)).toMatch(/^00:00/);
  await ruler.press("End");
  await expect
    .poll(() => playerTimecode(leader), { timeout: 8_000 })
    .not.toMatch(/^00:00\.000/);
  return playerTimecode(leader);
}

async function expectFollowerMatchesLeaderPlayhead(
  leader: Page,
  follower: Page,
): Promise<void> {
  const expected = await seekLeaderPlayhead(leader);
  await expect
    .poll(() => playerTimecode(follower), { timeout: 8_000 })
    .toBe(expected);
}

async function stopFollowing(follower: Page): Promise<void> {
  const banner = follower.locator(".follow-banner");
  if (!(await banner.isVisible())) {
    return;
  }
  await follower
    .getByRole("button", { name: /Stop following/ })
    .first()
    .click();
  await expect(banner).toHaveCount(0);
}

async function movePointer(
  page: Page,
  loc: ReturnType<Page["locator"]>,
  offset?: { x: number; y: number },
): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(loc).toBeVisible();
  const box = await loc.boundingBox();
  expect(box).toBeTruthy();
  const x = box!.x + (offset?.x ?? box!.width / 2);
  const y = box!.y + (offset?.y ?? box!.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.move(x + 2, y);
  return box!;
}

/** The hear menu shows `mode` as the one chosen. */
async function expectAudition(page: Page, mode: Audition): Promise<void> {
  const row = page.getByRole("menuitemradio", { name: AUDITION_NAMES[mode] });
  await expect(async () => {
    await page.getByRole("button", { name: "Hear options" }).click();
    await expect(row).toHaveAttribute("aria-checked", "true", {
      timeout: 1_000,
    });
  }).toPass({ timeout: 8_000 });
  await page.keyboard.press("Escape");
  await expect(row).toBeHidden();
}

async function expectGuestListeningInMix(page: Page): Promise<void> {
  await expect(page.locator(".follow-banner")).toContainText(
    /Listening in Mix/,
  );
  // A guest hears the mix only: the Player has no hear menu to change it.
  await expect(page.getByRole("button", { name: "Hear options" })).toHaveCount(
    0,
  );
}

async function followPeerUntilPlayheadMirrors(
  follower: Page,
  leader: Page,
): Promise<void> {
  const rows = () =>
    follower
      .getByRole("menu", { name: "People" })
      .getByRole("menuitem", { name: /· Follow$/ });
  await openPeopleMenu(follower);
  await expect(rows().first()).toBeVisible({ timeout: 15_000 });
  const peopleBox = await rows().first().boundingBox();
  // Menu rows take the touch floor on a coarse pointer, not by width.
  if (await follower.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    expect(peopleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const n = await rows().count();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      await stopFollowing(follower);
      await openPeopleMenu(follower);
    }
    await clickHTMLElement(rows().nth(i));
    if (!(await waitForFollowBanner(follower))) {
      continue;
    }
    try {
      await expectFollowerMatchesLeaderPlayhead(leader, follower);
      return;
    } catch {
      await stopFollowing(follower);
    }
  }
  throw new Error("no live Follow peer mirrored the leader playhead");
}

async function withTwoStudioPages<T>(
  browser: Pick<Browser, "newContext">,
  viewport: { width: number; height: number },
  run: (pageA: Page, pageB: Page) => Promise<T>,
  followerViewport = viewport,
): Promise<T> {
  return withShareableProject(async (projectPath) => {
    return withTwoBrowserPages(
      browser,
      { viewport },
      { viewport: followerViewport },
      async (pageA, pageB) => {
        await openHostShare(pageA, projectPath);
        await openHostShare(pageB, projectPath);
        return await run(pageA, pageB);
      },
    );
  });
}

async function withHostGuestPages<T>(
  browser: Browser,
  role: "viewer" | "editor",
  run: (host: Page, guest: Page) => Promise<T>,
  guestViewport: { width: number; height: number } = DESKTOP,
): Promise<T> {
  return withShareableProject(async (projectPath) => {
    return withTwoBrowserPages(
      browser,
      { viewport: DESKTOP },
      { viewport: guestViewport },
      async (host, guest) => {
        await openHostShare(host, projectPath);
        const token = await test.step(
          role === "editor" ? "create editor share" : "create viewer share",
          async () => createReviewShare(host, projectPath, role),
        );
        await test.step(
          role === "editor" ? "open editor guest" : "open viewer guest",
          async () => openGuestShare(guest, token),
        );
        return await run(host, guest);
      },
    );
  });
}

test("closes the first context when the second context cannot be created", async ({
  browser,
}) => {
  let firstContext: BrowserContext | undefined;
  let closed = false;
  const failingBrowser: Pick<Browser, "newContext"> = {
    newContext: async (options) => {
      if (firstContext) throw new Error("second context failed");
      firstContext = await browser.newContext(options);
      firstContext.once("close", () => {
        closed = true;
      });
      const close = firstContext.close.bind(firstContext);
      firstContext.close = async () => {
        await close();
        throw new Error("cleanup failed");
      };
      return firstContext;
    },
  };
  await expect(
    withTwoStudioPages(failingBrowser, DESKTOP, async () => {
      throw new Error("callback should not run");
    }),
  ).rejects.toThrow("second context failed");
  expect(closed).toBe(true);
});

test.describe("presence follow desktop", () => {
  test("page B follows page A then unfollows on scroll", async ({
    browser,
  }) => {
    await withTwoStudioPages(browser, DESKTOP, async (pageA, pageB) => {
      await zoomTimelineIn(pageA, { maxSteps: 16, minRangePx: 200 });
      await followPeerUntilPlayheadMirrors(pageB, pageA);
      await expect(
        pageB.locator(".timeline-area[data-following]"),
      ).toBeVisible();
      await expect(pageB.locator(".sys-presence")).toBeAttached();
      await expectPageAxeClean(pageB);

      await scrollTimelineBy(pageB, 80);
      await expect(pageB.locator(".follow-banner")).toHaveCount(0);
      await expect(pageB.locator(".timeline-area[data-following]")).toHaveCount(
        0,
      );
    });
  });

  test("follows the Review queue then unfollows on a stage change", async ({
    browser,
  }) => {
    await withTwoStudioPages(browser, DESKTOP, async (pageA, pageB) => {
      await followPeerUntilPlayheadMirrors(pageB, pageA);
      await openPanel(pageA, "comments");
      await expect(pageA.locator(".rv-stage")).toBeVisible();
      await expect(pageB.locator(".rv-stage")).toBeVisible();
      await expect(pageB.locator(".follow-banner")).toBeVisible();
      await goToStage(pageB, "edit");
      await expect(pageB.locator(".follow-banner")).toHaveCount(0);
    });
  });

  test("ghost on chrome then hides off-surface", async ({ browser }) => {
    await withTwoStudioPages(browser, DESKTOP, async (pageA, pageB) => {
      await expect(peopleButton(pageB)).toBeVisible({ timeout: 15_000 });
      await pageA.bringToFront();
      await movePointer(
        pageA,
        pageA.locator('[data-presence-anchor="track:guest:mute"]'),
      );
      await expect(pageB.locator(".presence-cursor--ghost")).toBeVisible({
        timeout: 8_000,
      });
      await pageA.mouse.move(DESKTOP.width - 4, DESKTOP.height - 4);
      await expect(pageB.locator(".presence-cursor--ghost")).toHaveCount(0, {
        timeout: 8_000,
      });
    });
  });

  test("a remote playhead draws a flag on the ruler and a line down into the lanes", async ({
    browser,
  }) => {
    await withTwoStudioPages(browser, DESKTOP, async (pageA, pageB) => {
      await expect(peopleButton(pageB)).toBeVisible({ timeout: 15_000 });
      await seekLeaderPlayhead(pageA);
      const flag = pageB.locator(".sys-presence-flag").first();
      const line = pageB.locator(".sys-presence-line").first();
      await expect(flag).toBeVisible({ timeout: 8_000 });
      const ruler = await pageB.locator(".timeline-ruler").boundingBox();
      const lane = await pageB
        .locator(".lane-row[data-track-id]")
        .first()
        .boundingBox();
      const flagBox = await flag.boundingBox();
      const lineBox = await line.boundingBox();
      expect(ruler && lane && flagBox && lineBox).toBeTruthy();
      // The flag sits on the ruler, above the sticky ruler's paint.
      expect(flagBox!.y).toBeGreaterThanOrEqual(ruler!.y - 1);
      expect(flagBox!.y + flagBox!.height).toBeLessThanOrEqual(
        ruler!.y + ruler!.height + 1,
      );
      // The layer paints above the sticky ruler (it takes no pointer, so
      // elementFromPoint cannot see it; compare the stacking order).
      const zIndex = await pageB.evaluate(() => {
        const z = (sel: string) =>
          Number(getComputedStyle(document.querySelector(sel)!).zIndex);
        return {
          layer: z(".timeline-presence-window"),
          ruler: z(".timeline-ruler"),
          marker: z(".marker-lane"),
        };
      });
      expect(zIndex.layer).toBeGreaterThan(zIndex.ruler);
      expect(zIndex.layer).toBeGreaterThan(zIndex.marker);
      // The line runs from the ruler's top into the lanes.
      expect(lineBox!.y).toBeLessThanOrEqual(ruler!.y + 1);
      expect(lineBox!.y + lineBox!.height).toBeGreaterThan(lane!.y + 8);
      await expectPageAxeClean(pageB);
    });
  });

  test("under a vertical scroll the remote flag moves with the lanes while the ruler stays pinned", async ({
    browser,
  }) => {
    await withTwoStudioPages(
      browser,
      { width: 1280, height: 380 },
      async (pageA, pageB) => {
        await expect(peopleButton(pageB)).toBeVisible({ timeout: 15_000 });
        await seekLeaderPlayhead(pageA);
        const flag = pageB.locator(".sys-presence-flag").first();
        await expect(flag).toBeVisible({ timeout: 8_000 });
        const ruler = pageB.locator(".timeline-ruler");
        const scroller = pageB.locator(".timeline-scroll");
        const room = await scroller.evaluate(
          (el) => el.scrollHeight - el.clientHeight,
        );
        expect(room).toBeGreaterThan(20);
        const before = {
          flag: (await flag.boundingBox())!.y,
          ruler: (await ruler.boundingBox())!.y,
        };
        const by = Math.min(room, 40);
        await scroller.evaluate((el, top) => {
          el.scrollTop = top;
        }, by);
        await expect
          .poll(async () => (await flag.boundingBox())!.y, { timeout: 5_000 })
          .toBeCloseTo(before.flag - by, 0);
        // The ruler is pinned; the flag is not (option A, documented in spec-edit OVL-PRESENCE).
        expect((await ruler.boundingBox())!.y).toBeCloseTo(before.ruler, 0);
      },
    );
  });

  test("mirrors FX audition and mute does not unfollow", async ({
    browser,
  }) => {
    await withTwoStudioPages(browser, DESKTOP, async (pageA, pageB) => {
      await followPeerUntilPlayheadMirrors(pageB, pageA);
      await setAudition(pageA, "fx");
      await expectAudition(pageB, "fx");
      // Both tabs are the host, so M saves the mute for everyone (#386).
      const muteA = pageA.locator('[data-presence-anchor="track:guest:mute"]');
      const muteB = pageB.locator('[data-presence-anchor="track:guest:mute"]');
      await muteB.click();
      await expect(muteA).toHaveAttribute("data-mute-state", "saved", {
        timeout: 8_000,
      });
      // Checked after the server has applied it, when an unfollow would show.
      await expect(pageB.locator(".follow-banner")).toBeVisible();
      await muteB.click();
      await expect(muteA).toHaveAttribute("data-mute-state", "off", {
        timeout: 8_000,
      });
      await expect(pageB.locator(".follow-banner")).toBeVisible();
    });
  });
});

test.describe("presence follow tablet", () => {
  test("follows from Menu People then unfollows", async ({ browser }) => {
    await withTwoStudioPages(browser, TABLET, async (pageA, pageB) => {
      await expect(pageA.locator(".stage-frame--tablet")).toBeVisible();
      await expect(pageB.locator(".stage-frame--tablet")).toBeVisible();
      await followUntilBannerVisible(pageB);
      await expect(pageB.locator(".follow-banner")).toBeVisible();
      await expect(pageB.locator(".sys-presence")).toBeAttached();

      await clickHTMLElement(
        pageB.getByRole("button", { name: "Stop following", exact: true }),
      );
      await expect(pageB.locator(".follow-banner")).toHaveCount(0);
    });
  });
});

test.describe("presence follow phone", () => {
  test("follow banner then unfollow on Listen", async ({ browser }) => {
    await withTwoStudioPages(browser, PHONE, async (pageA, pageB) => {
      await expect(pageB.locator(".stage-frame--phone")).toBeVisible();
      await followPeerUntilPlayheadMirrors(pageB, pageA);
      const banner = pageB.locator(".follow-banner");
      await expect(banner).toBeVisible();
      const bannerBox = await banner.boundingBox();
      const vw = pageB.viewportSize()?.width ?? 390;
      expect(bannerBox).toBeTruthy();
      expect(bannerBox!.x).toBeGreaterThanOrEqual(0);
      expect(bannerBox!.x + bannerBox!.width).toBeLessThanOrEqual(vw + 1);

      await phone.showListen(pageB);
      await expect(pageB.locator(".follow-banner")).toHaveCount(0);
    });
  });

  test("follow survives phone to desktop remount", async ({ browser }) => {
    await withTwoStudioPages(
      browser,
      DESKTOP,
      async (_pageA, pageB) => {
        await expect(pageB.locator(".stage-frame--phone")).toBeVisible();
        await followUntilBannerVisible(pageB);
        const banner = pageB.locator(".follow-banner");
        await expect(banner).toBeVisible();
        const label =
          (await pageB.locator(".follow-banner-text").textContent()) ?? "";
        const followed =
          label.match(/^Following\s+(.+?)(?:\s+·|$)/)?.[1]?.trim() ?? "";
        expect(followed).not.toBe("");
        await pageB.setViewportSize(DESKTOP);
        await expect(pageB.locator(".stage-frame--phone")).toHaveCount(0, {
          timeout: 8_000,
        });
        await expect(
          pageB.locator(".stage-frame--desktop.stage-frame--following"),
        ).toBeVisible();
        await expect(banner).toBeVisible();
        await expect(banner).toContainText(`Following ${followed}`);
      },
      PHONE,
    );
  });
});

test.describe("presence follow guest share", () => {
  test("guest follows host on a share token", async ({ browser }) => {
    await withHostGuestPages(browser, "viewer", async (pageA, pageB) => {
      await goToStage(pageA, "prepare");
      const menu = await openPeopleMenu(pageB);
      const followHost = menu.getByRole("menuitem", { name: /Host · Follow$/ });
      await expect(followHost).toBeVisible({ timeout: 15_000 });
      await followHost.click();
      const followBanner = pageB.locator(".follow-banner");
      await expect(followBanner).toBeVisible();
      // A viewer has no timeline, so there is no presence overlay to attach.
      await expect(followBanner).toContainText(/in Pipeline \(host-only\)/);
      // A viewer has Review only, so the host's Prepare stage stays out of reach.
      await expect(pageB.getByRole("main", { name: "Review" })).toBeVisible();

      await setAudition(pageA, "fx");
      await expect(pageB.locator(".follow-banner")).toContainText(
        /auditioning FX/,
      );
      await expectGuestListeningInMix(pageB);
    });
  });

  test("phone guest banner truncates and keeps Stop following in the shell", async ({
    browser,
  }) => {
    await withHostGuestPages(
      browser,
      "viewer",
      async (host, guest) => {
        await expect(guest.locator(".stage-frame--phone")).toBeVisible();
        await goToStage(host, "prepare");
        await followUntilBannerVisible(guest);
        await setAudition(host, "fx");
        const banner = guest.locator(".follow-banner");
        // The degrade detail makes the text longer than a 360px row.
        await expect(banner).toContainText(/auditioning FX/);
        const text = guest.locator(".follow-banner-text");
        // Ellipsis truncation (presence.css) instead of widening the banner.
        await expect
          .poll(() => text.evaluate((el) => el.scrollWidth > el.clientWidth))
          .toBe(true);
        const shellBox = await guest.locator(".stage-frame").boundingBox();
        const stopBox = await guest
          .locator(".follow-banner-stop")
          .boundingBox();
        expect(shellBox).toBeTruthy();
        expect(stopBox).toBeTruthy();
        expect(stopBox!.x + stopBox!.width).toBeLessThanOrEqual(
          shellBox!.x + shellBox!.width + 1,
        );
      },
      NARROW_PHONE,
    );
  });

  test("editor guest Mix lock after host FX", async ({ browser }) => {
    await withHostGuestPages(browser, "editor", async (pageA, pageB) => {
      await test.step("publish host FX presence", async () => {
        await setAudition(pageA, "fx");
      });
      await test.step("follow host FX presence", async () => {
        const menu = await openPeopleMenu(pageB);
        const follows = menu.getByRole("menuitem", { name: /· Follow$/ });
        await expect(follows).toHaveCount(1, { timeout: 15_000 });
        await follows.click();
        await expect(pageB.locator(".follow-banner")).toContainText(
          /auditioning FX/,
          { timeout: 15_000 },
        );
      });
      await test.step("verify guest Mix lock", async () => {
        await expectGuestListeningInMix(pageB);
      });
    });
  });
});
