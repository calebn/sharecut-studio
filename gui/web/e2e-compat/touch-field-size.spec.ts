import { expect, type Locator, test } from "@playwright/test";
import {
  envelopeTrack,
  openEnvelopeTrackDetails,
} from "../e2e/envelopeCreationEvidence";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";
import { setTheme } from "../e2e/theme";

test.use({ hasTouch: true, reducedMotion: "reduce" });

/** iOS Safari zooms the page when a focused field is under this size (#1354). */
const IOS_ZOOM_FLOOR_PX = 16;

function fontSizePx(field: Locator) {
  return field.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`touch field size ${theme}`, () => {
    test("iPhone envelope Time field is at least 16px", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await withShareableProject(async (projectPath) => {
        await openHostShare(page, projectPath);
        await openPhoneTimeline(page);
        await setTheme(page, theme);
        await expect
          .poll(() =>
            page.evaluate(() => matchMedia("(pointer: coarse)").matches),
          )
          .toBe(true);
        await openEnvelopeTrackDetails(
          page,
          envelopeTrack(projectPath).label,
          [],
        );
        await page
          .getByRole("button", { name: "Add volume envelope", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Add point", exact: true })
          .click();
        const time = page.getByLabel("Time (seconds on timeline)", {
          exact: true,
        });
        await expect(time).toBeVisible();
        expect(await fontSizePx(time)).toBeGreaterThanOrEqual(
          IOS_ZOOM_FLOOR_PX,
        );
      });
    });

    test("touch comment field is at least 16px", async ({ page }) => {
      await page.setViewportSize({ width: 1024, height: 768 });
      await withShareableProject(async (projectPath) => {
        await openHostShare(page, projectPath);
        await setTheme(page, theme);
        await page
          .getByRole("button", { name: "Comment", exact: true })
          .first()
          .click();
        await page.getByRole("slider", { name: "Comment time anchor" }).click();
        const comment = page.getByRole("textbox", {
          name: "Comment",
          exact: true,
        });
        await expect(comment).toBeVisible();
        expect(await fontSizePx(comment)).toBeGreaterThanOrEqual(
          IOS_ZOOM_FLOOR_PX,
        );
      });
    });
  });
}
