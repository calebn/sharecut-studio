import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { clickHTMLElement } from "./domClick";
import { waitForFollowBanner } from "./followBanner";
import { withShareableProject } from "./shareableProject";
import { openGuestShare, openHostShare } from "./shareNavigation";
import { withTwoBrowserPages } from "./twoBrowserPages";

const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 820, height: 1180 };
const PHONE = { width: 390, height: 844 };
async function transportTimecode(page: Page): Promise<string> {
  // Phone Listen renders a full pair in its body; other shells use header
  // transport's compact timecode. Compare the shared playhead portion.
  const [timecode = ""] = await page
    .locator(".listen-hero .timecode, header.transport .timecode")
    .allTextContents();
  return timecode.split("/")[0]?.trim() ?? "";
}

/** Shared GUI process keeps leftover roster entries; prove the peer is this leader. */
async function seekLeaderPlayhead(leader: Page): Promise<string> {
  const ruler = leader.getByRole("slider", { name: "Timeline position" });
  const scrub = leader.locator(".mobile-scrub");
  if (await ruler.count()) {
    await expect(ruler).toBeVisible();
    await ruler.focus();
    await ruler.press("Home");
    await expect.poll(() => transportTimecode(leader)).toMatch(/^00:00/);
    await ruler.press("End");
  } else {
    await expect(scrub).toBeVisible();
    await scrub.evaluate((el) => {
      const input = el as HTMLInputElement;
      const max = Number(input.max) || 2;
      const desc = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      );
      if (desc?.set) {
        desc.set.call(input, "0");
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      if (desc?.set) {
        desc.set.call(input, String(max));
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  await expect
    .poll(() => transportTimecode(leader), { timeout: 8_000 })
    .not.toMatch(/^00:00\.000/);
  return transportTimecode(leader);
}

async function expectFollowerMatchesLeaderPlayhead(
  leader: Page,
  follower: Page,
): Promise<void> {
  const expected = await seekLeaderPlayhead(leader);
  await expect
    .poll(() => transportTimecode(follower), { timeout: 8_000 })
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

async function expectGuestListeningInMix(page: Page): Promise<void> {
  await expect(page.locator(".follow-banner")).toContainText(
    /Listening in Mix/,
  );
  await expect(
    page.locator('[data-presence-anchor="audition:mix"][aria-pressed="true"]'),
  ).toBeVisible();
  const fx = page.locator('[data-presence-anchor="audition:fx"]');
  const raw = page.locator('[data-presence-anchor="audition:raw"]');
  await expect(fx).toBeDisabled();
  await expect(raw).toBeDisabled();
  await expect(fx).not.toHaveAttribute("aria-pressed", "true");
}

async function followUntilBannerVisible(
  follower: Page,
  openMenu: () => Promise<void>,
): Promise<void> {
  await openMenu();
  const people = follower.getByRole("menuitem", { name: /Follow/ });
  await expect(people.first()).toBeVisible({ timeout: 15_000 });
  const n = await people.count();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      await openMenu();
    }
    await clickHTMLElement(people.nth(i));
    if (await waitForFollowBanner(follower)) {
      return;
    }
  }
  throw new Error("no Follow peer showed a banner");
}

async function followMenuPeerUntilPlayheadMoves(
  follower: Page,
  leader: Page,
  openMenu: () => Promise<void>,
): Promise<void> {
  await openMenu();
  const people = follower.getByRole("menuitem", { name: /Follow/ });
  await expect(people.first()).toBeVisible({ timeout: 15_000 });
  const peopleBox = await people.first().boundingBox();
  expect(peopleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  const n = await people.count();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      await openMenu();
    }
    await clickHTMLElement(people.nth(i));
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

async function followUntilLeaderPlayheadMirrors(
  follower: Page,
  leader: Page,
): Promise<void> {
  const buttons = follower.getByRole("button", { name: /Follow / });
  await expect(buttons.first()).toBeVisible({ timeout: 15_000 });
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    await stopFollowing(follower);
    await follower
      .getByRole("button", { name: /Follow / })
      .nth(i)
      .click();
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
  throw new Error("no Follow peer mirrored the leader playhead");
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
): Promise<T> {
  return withShareableProject(async (projectPath) => {
    return withTwoBrowserPages(
      browser,
      { viewport: DESKTOP },
      { viewport: DESKTOP },
      async (host, guest) => {
        await openHostShare(host, projectPath);
        const token = await test.step(
          role === "editor" ? "create editor share" : "create viewer share",
          async () => {
            const created = await host.request.post("/api/shares", {
              data: { path: projectPath, role },
            });
            expect(created.ok(), await created.text()).toBeTruthy();
            const body = (await created.json()) as { share: { token: string } };
            return body.share.token;
          },
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
      await followUntilLeaderPlayheadMirrors(pageB, pageA);
      await expect(
        pageB.locator(".timeline-area[data-following]"),
      ).toBeVisible();
      await expect(pageB.locator(".presence-overlay")).toBeAttached();
      await expectPageAxeClean(pageB);

      await pageB.locator(".timeline-scroll").evaluate((el) => {
        el.scrollLeft = 80;
      });
      await expect(pageB.locator(".follow-banner")).toHaveCount(0);
      await expect(pageB.locator(".timeline-area[data-following]")).toHaveCount(
        0,
      );
    });
  });

  test("follows Comments tab then unfollows on Transcript click", async ({
    browser,
  }) => {
    await withTwoStudioPages(browser, DESKTOP, async (pageA, pageB) => {
      await followUntilLeaderPlayheadMirrors(pageB, pageA);
      const comments = pageA.locator('[data-presence-anchor="tab:comments"]');
      await comments.click();
      await expect(comments).toHaveAttribute("aria-pressed", "true");
      await expect(
        pageB.locator('[data-presence-anchor="tab:comments"]'),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(pageB.locator(".follow-banner")).toBeVisible();
      await pageB.locator('[data-presence-anchor="tab:transcript"]').click();
      await expect(pageB.locator(".follow-banner")).toHaveCount(0);
    });
  });

  test("ghost on chrome then hides off-surface", async ({ browser }) => {
    await withTwoStudioPages(browser, DESKTOP, async (pageA, pageB) => {
      const follow = pageB.getByRole("button", { name: /Follow / }).first();
      await expect(follow).toBeVisible({ timeout: 15_000 });
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

  test("timeline ghost hides below the last lane", async ({ browser }) => {
    await withTwoStudioPages(browser, DESKTOP, async (pageA, pageB) => {
      await expect(
        pageB.getByRole("button", { name: /Follow / }).first(),
      ).toBeVisible({ timeout: 15_000 });
      await pageA.bringToFront();
      const lastLane = pageA.locator(".lane-row[data-track-id]").last();
      await expect(lastLane).toBeVisible();
      const box = await lastLane.boundingBox();
      expect(box).toBeTruthy();
      const laneH = box!.height;
      await movePointer(pageA, lastLane, {
        x: Math.max(48, box!.width / 2),
        y: laneH - 4,
      });
      await expect(
        pageB.locator(".presence-overlay .presence-cursor").first(),
      ).toBeVisible({ timeout: 8_000 });
      await pageA.mouse.move(box!.x + 40, box!.y + laneH + 8);
      await expect(
        pageB.locator(".presence-overlay .presence-cursor"),
      ).toHaveCount(0, { timeout: 4_000 });
    });
  });

  test("mirrors FX audition and mute does not unfollow", async ({
    browser,
  }) => {
    await withTwoStudioPages(browser, DESKTOP, async (pageA, pageB) => {
      await followUntilLeaderPlayheadMirrors(pageB, pageA);
      await pageA.locator('[data-presence-anchor="audition:fx"]').click();
      await expect(
        pageB.locator(
          '[data-presence-anchor="audition:fx"][aria-pressed="true"]',
        ),
      ).toBeVisible({ timeout: 8_000 });
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
      await expect(pageA.locator(".daw-shell--tablet")).toBeVisible();
      await expect(pageB.locator(".daw-shell--tablet")).toBeVisible();
      await followUntilBannerVisible(pageB, async () => {
        await pageB
          .getByRole("button", { name: "Menu" })
          .click({ force: true });
      });
      await expect(pageB.locator(".follow-banner")).toBeVisible();
      await expect(pageB.locator(".presence-overlay")).toBeAttached();

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
      await expect(pageB.locator(".daw-shell--phone")).toBeVisible();
      await followMenuPeerUntilPlayheadMoves(pageB, pageA, async () => {
        await pageB
          .getByRole("navigation", { name: "Primary" })
          .getByRole("button", { name: "More" })
          .click({ force: true });
      });
      const banner = pageB.locator(".follow-banner");
      await expect(banner).toBeVisible();
      const bannerBox = await banner.boundingBox();
      const vw = pageB.viewportSize()?.width ?? 390;
      expect(bannerBox).toBeTruthy();
      expect(bannerBox!.x).toBeGreaterThanOrEqual(0);
      expect(bannerBox!.x + bannerBox!.width).toBeLessThanOrEqual(vw + 1);

      await pageB
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Listen" })
        .click();
      await expect(pageB.locator(".follow-banner")).toHaveCount(0);
    });
  });

  test("follow survives phone to desktop remount", async ({ browser }) => {
    await withTwoStudioPages(
      browser,
      DESKTOP,
      async (_pageA, pageB) => {
        await expect(pageB.locator(".daw-shell--phone")).toBeVisible();
        await followUntilBannerVisible(pageB, async () => {
          await pageB
            .getByRole("navigation", { name: "Primary" })
            .getByRole("button", { name: "More" })
            .click({ force: true });
        });
        const banner = pageB.locator(".follow-banner");
        await expect(banner).toBeVisible();
        const label =
          (await pageB.locator(".follow-banner-text").textContent()) ?? "";
        const followed =
          label.match(/^Following\s+(.+?)(?:\s+·|$)/)?.[1]?.trim() ?? "";
        expect(followed).not.toBe("");
        await pageB.setViewportSize(DESKTOP);
        await expect(pageB.locator(".daw-shell--phone")).toHaveCount(0, {
          timeout: 8_000,
        });
        await expect(
          pageB.locator(".daw-shell--desktop.daw-shell--following"),
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
      await pageA.locator('[data-presence-anchor="tab:pipeline"]').click();
      const followHost = pageB.getByRole("button", {
        name: "Follow Host",
        exact: true,
      });
      await expect(followHost).toBeVisible({ timeout: 15_000 });
      await followHost.click();
      const followBanner = pageB.locator(".follow-banner");
      await expect(followBanner).toBeVisible();
      await expect(pageB.locator(".presence-overlay")).toBeAttached();
      await expect(followBanner).toContainText(/in Pipeline \(host-only\)/);
      await expect(
        pageB.locator(
          '[data-presence-anchor="tab:transcript"][aria-pressed="true"]',
        ),
      ).toBeVisible();

      await pageA.locator('[data-presence-anchor="audition:fx"]').click();
      await expect(pageB.locator(".follow-banner")).toContainText(
        /auditioning FX/,
      );
      await expectGuestListeningInMix(pageB);
    });
  });

  test("editor guest Mix lock after host FX", async ({ browser }) => {
    await withHostGuestPages(browser, "editor", async (pageA, pageB) => {
      await test.step("publish host FX presence", async () => {
        await pageA.locator('[data-presence-anchor="audition:fx"]').click();
      });
      await test.step("follow host FX presence", async () => {
        const follows = pageB.getByRole("button", { name: /Follow / });
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
