import { expect, type Locator, test } from "@playwright/test";
import {
  envelopeTrack,
  openEnvelopeTrackDetails,
} from "../e2e/envelopeCreationEvidence";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openHostShare } from "../e2e/shareNavigation";
import { openPanel } from "../e2e/stageNav";

test.use({ hasTouch: true, reducedMotion: "reduce" });

/** iOS Safari zooms the page when a focused field is under this size (#1354). */
const IOS_ZOOM_FLOOR_PX = 16;

function fontSizePx(field: Locator) {
  return field.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
}

test.describe("touch field size", () => {
  test("iPhone envelope Time field is at least 16px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await withShareableProject(async (projectPath) => {
      await openHostShare(page, projectPath);
      await openPhoneTimeline(page);
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
        .getByRole("button", { name: "Show volume envelope", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Add point", exact: true })
        .click();
      const time = page.getByLabel("Time (seconds on timeline)", {
        exact: true,
      });
      await expect(time).toBeVisible();
      expect(await fontSizePx(time)).toBeGreaterThanOrEqual(IOS_ZOOM_FLOOR_PX);
    });
  });

  test("iPhone comment field is at least 16px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await withShareableProject(async (projectPath) => {
      await openHostShare(page, projectPath);
      await openPanel(page, "comments");
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
