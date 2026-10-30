import { expect, type Locator, test } from "@playwright/test";
import {
  addEnvelopePoint,
  envelopeTrack,
  inspectEnvelopePoint,
  openEnvelopeTrackDetails,
  pointSheet,
  showEnvelope,
} from "../e2e/envelopeCreationEvidence";
import {
  openPhoneTimeline,
  rememberInspectorDetent,
} from "../e2e/phoneTimeline";
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
      await rememberInspectorDetent(page, "half");
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
      await showEnvelope(page);
      await addEnvelopePoint(page);
      await inspectEnvelopePoint(page);
      await pointSheet(page)
        .getByRole("spinbutton", { name: "Time", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      const time = pointSheet(page).getByRole("textbox", {
        name: "Time",
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
      await page.keyboard.press("c");
      const comment = page.locator(".rv-compose").getByRole("textbox", {
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
