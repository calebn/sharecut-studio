import { expect, test } from "@playwright/test";
import { expectFeedback } from "./feedback";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";

/**
 * #1960: a failure card must not cover Listen's Play row, the dock or the mode
 * nav on a short phone. 320x460 is the size where the dock spot used to land
 * on Play; the rest are the phone sizes and orientations around it.
 */
const PHONES = [
  { name: "320x460 portrait", width: 320, height: 460 },
  { name: "320x568 portrait", width: 320, height: 568 },
  { name: "360x520 portrait", width: 360, height: 520 },
  { name: "375x547 portrait (iPhone SE)", width: 375, height: 547 },
  { name: "390x844 portrait", width: 390, height: 844 },
  { name: "460x320 landscape", width: 460, height: 320 },
  { name: "568x320 landscape", width: 568, height: 320 },
  { name: "667x375 landscape", width: 667, height: 375 },
  { name: "844x390 landscape", width: 844, height: 390 },
] as const;

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

test.use({
  hasTouch: true,
  storageState: { cookies: [], origins: [] },
});

for (const phone of PHONES) {
  test(`the failure card clears Play at ${phone.name}`, async ({ page }) => {
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await withShareableProject(async (projectPath) => {
      await page.route("**/api/pipeline/render-preview", (route) =>
        route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Bad request" }),
        }),
      );
      await openProject(page, projectPath);
      const play = page.getByRole("button", { name: "Play", exact: true });
      await expect(play).toBeVisible();
      await expectFeedback(page, /^Refresh failed/);
      const card = page.locator(".ui-toast-region--app .ui-toast");
      const nav = page.locator(".stage-frame-tabs");
      // A short landscape window scrolls Listen's hero under the comment
      // field; bring Play into view, as a person would to press it.
      await play.scrollIntoViewIfNeeded();
      await expect(async () => {
        const cardBox = await card.boundingBox();
        const playBox = await play.boundingBox();
        expect(cardBox).not.toBeNull();
        expect(playBox).not.toBeNull();
        if (!cardBox || !playBox) return;
        expect(overlaps(cardBox, playBox)).toBe(false);
        if (await nav.count()) {
          const navBox = await nav.boundingBox();
          if (navBox) expect(overlaps(cardBox, navBox)).toBe(false);
        }
        expect(cardBox.y).toBeGreaterThanOrEqual(0);
        expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(
          phone.height + 0.5,
        );
        expect(cardBox.x).toBeGreaterThanOrEqual(0);
        expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(
          phone.width + 0.5,
        );
        const hit = await page.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest("button")
              ?.getAttribute("aria-label") ?? null,
          {
            x: playBox.x + playBox.width / 2,
            y: playBox.y + playBox.height / 2,
          },
        );
        expect(hit).toBe("Play");
      }).toPass({ timeout: 6000 });
    });
  });
}
