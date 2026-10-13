import { devices, expect, type Page, test } from "@playwright/test";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";

/*
 * #1372: a Menu opened from a phone track sheet stays inside the visual
 * viewport. The panel used to hang right-aligned off a trigger at the sheet's
 * left edge, so it opened at x = -125.8 and nothing in it could be tapped.
 */

const phone = devices["iPhone 15 Pro"];

test.use({
  viewport: phone.viewport,
  userAgent: phone.userAgent,
  deviceScaleFactor: phone.deviceScaleFactor,
  isMobile: phone.isMobile,
  hasTouch: phone.hasTouch,
  reducedMotion: "reduce",
});

function viewportBox(page: Page) {
  return page.evaluate(() => {
    const vv = window.visualViewport;
    return {
      left: vv?.offsetLeft ?? 0,
      top: vv?.offsetTop ?? 0,
      width: vv?.width ?? window.innerWidth,
      height: vv?.height ?? window.innerHeight,
    };
  });
}

for (const width of [390, 393]) {
  for (const detent of ["half", "full"] as const) {
    test(`Track actions opens inside the viewport at ${width} wide, ${detent} detent, and its first item works`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 852 });
      await withShareableProject(async (projectPath) => {
        await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
        await openPhoneTimeline(page);
        await page.locator(".track-header-open").first().tap();
        const sheet = page.getByRole("dialog", { name: "Inspector" });
        await expect(sheet).toBeVisible();
        if (detent === "full") {
          await sheet
            .getByRole("button", { name: "Expand", exact: true })
            .tap();
          await expect(
            sheet.getByRole("button", { name: "Collapse", exact: true }),
          ).toBeVisible();
        }

        await sheet.getByRole("button", { name: "Track actions" }).tap();
        const menu = page.getByRole("menu", { name: "Track actions" });
        await expect(menu).toBeVisible();

        const box = await menu.boundingBox();
        const viewport = await viewportBox(page);
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(viewport.left);
        expect(box!.y).toBeGreaterThanOrEqual(viewport.top);
        expect(box!.x + box!.width).toBeLessThanOrEqual(
          viewport.left + viewport.width,
        );
        expect(box!.y + box!.height).toBeLessThanOrEqual(
          viewport.top + viewport.height,
        );

        const first = menu.getByRole("menuitem").first();
        await expect(first).toHaveAccessibleName("Smooth all joins");
        const itemBox = await first.boundingBox();
        const topmost = await page.evaluate(
          ({ x, y }) => {
            const hit = document.elementFromPoint(x, y);
            return hit?.closest('[role="menuitem"]')?.textContent ?? null;
          },
          {
            x: itemBox!.x + itemBox!.width / 2,
            y: itemBox!.y + itemBox!.height / 2,
          },
        );
        expect(topmost).toBe("Smooth all joins");

        const applied = page.waitForRequest(
          (request) =>
            request.method() === "POST" &&
            (request.postData() ?? "").includes("ApplyFadeRecommendations"),
        );
        await first.tap();
        await applied;
        await expect(menu).toHaveCount(0);
      });
    });
  }
}
