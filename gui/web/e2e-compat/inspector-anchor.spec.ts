import { expect, test } from "@playwright/test";
import { createScriptRecordingIdentityProject } from "../e2e/scriptRecordingIdentityProject";
import { withShareableProject } from "../e2e/shareableProject";
import { openProject } from "../e2e/stageNav";
import { zoomTimelineIn } from "../e2e/timelineZoom";

test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

test("I reveals and focuses the Inspector for a clip panned off the Timeline", async ({
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openProject(page, projectPath);
      await expect(page.locator("html")).toHaveAttribute(
        "data-shell",
        "desktop",
      );
      await zoomTimelineIn(page, { maxSteps: 12, minRangePx: 1000 });
      const clip = page.locator('[data-clip-id="left"] .clip-hit');
      const inspector = page.getByRole("dialog", {
        name: "Inspector",
        exact: true,
      });

      await clip.press("Enter");
      await expect(clip).toHaveAttribute("aria-pressed", "true");
      await expect(clip).toBeInViewport();
      await expect(inspector).toBeHidden();

      const timeline = page.locator(".timeline-scroll");
      const bounds = await timeline.boundingBox();
      if (!bounds) throw new Error("The Timeline scrollport has no bounds");
      await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + 8);
      await page.mouse.wheel(1000, 0);
      await expect(clip).not.toBeInViewport();
      await expect(clip).toHaveAttribute("aria-pressed", "true");

      const position = page.getByRole("slider", { name: "Timeline position" });
      const time = await position.getAttribute("aria-valuenow");
      if (time === null) throw new Error("The Timeline position has no time");
      await page.keyboard.press("i");
      await expect(inspector).toBeVisible();
      await expect(clip).toBeInViewport();
      await expect(inspector.locator(":focus")).toHaveCount(1);
      await expect(clip).toHaveAttribute("aria-pressed", "true");
      await expect(position).toHaveAttribute("aria-valuenow", time);

      await page.keyboard.press("Escape");
      await expect(inspector).toBeHidden();
      await expect(clip).toBeFocused();

      const visibleScroll = await timeline.evaluate((el) => el.scrollLeft);
      await page.keyboard.press("i");
      await expect(inspector).toBeVisible();
      expect(await timeline.evaluate((el) => el.scrollLeft)).toBe(
        visibleScroll,
      );
      await page.mouse.wheel(1000, 0);
      await expect(clip).not.toBeInViewport();
      await expect(inspector).toBeHidden();
      await page.mouse.wheel(-1000, 0);
      await expect(clip).toBeInViewport();
      await expect(inspector).toBeVisible();
    },
    undefined,
    createScriptRecordingIdentityProject,
  );
});
