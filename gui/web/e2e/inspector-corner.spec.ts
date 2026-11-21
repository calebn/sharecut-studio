import { expect, type Locator, test } from "@playwright/test";
import { rulerWidthPx } from "./deepZoom";
import { controlGeometry } from "./inspectorResponsiveEvidence";
import { createScriptRecordingIdentityProject } from "./scriptRecordingIdentityProject";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";

test.use({
  viewport: { width: 820, height: 1180 },
  hasTouch: true,
  reducedMotion: "reduce",
});

async function expectSeparate(card: Locator, corner: Locator) {
  await expect
    .poll(
      async () => {
        const [panel, controls] = await Promise.all([
          card.boundingBox(),
          corner.boundingBox(),
        ]);
        if (!panel || !controls) return null;
        const width =
          Math.min(panel.x + panel.width, controls.x + controls.width) -
          Math.max(panel.x, controls.x);
        const height =
          Math.min(panel.y + panel.height, controls.y + controls.height) -
          Math.max(panel.y, controls.y);
        return Math.max(0, width) * Math.max(0, height);
      },
      {
        message:
          "The Inspector's overlap with the Timeline controls in CSS square pixels",
      },
    )
    .toBe(0);
}

test("tablet Timeline controls stay reachable beside the Inspector", async ({
  page,
}) => {
  await withShareableProject(
    async (projectPath) => {
      await openProject(page, projectPath);
      const corner = page.getByRole("group", { name: "Timeline view" });
      const card = page.getByRole("dialog", { name: "Inspector", exact: true });
      const clip = page.locator('[data-clip-id="other"] .clip-hit');
      const ruler = page.locator(".timeline-ruler");
      const widthAtFit = await rulerWidthPx(page);
      await ruler.tap({ position: { x: 0.9 * widthAtFit, y: 8 } });
      await clip.press("Enter");
      await expect(clip).toHaveAttribute("aria-pressed", "true");
      await expect(card).toBeHidden();
      const inspect = page.getByRole("button", {
        name: "Inspect",
        exact: true,
      });
      await inspect.tap();
      await expect(card).toBeVisible();
      await expect(corner).toBeVisible();
      await expectSeparate(card, corner);

      const zoom = corner.getByRole("button", { name: "Zoom in", exact: true });
      const script = corner.getByRole("button", {
        name: "Show or hide Script",
        exact: true,
      });
      const close = card.getByRole("button", { name: "Close", exact: true });
      for (const control of [zoom, script, close]) {
        await expect
          .poll(async () => {
            const geometry = await controlGeometry(control);
            return {
              label: geometry.measured[0]?.label,
              fullyVisible: geometry.fullyVisible,
              hitsControl: geometry.hitsControl,
              hit: geometry.hit,
            };
          })
          .toMatchObject({
            fullyVisible: true,
            hitsControl: true,
          });
      }

      const clipWidth = () =>
        clip.evaluate((element) => element.getBoundingClientRect().width);
      const width = await clipWidth();
      await zoom.tap();
      await expect.poll(clipWidth).toBeGreaterThan(width);
      await expect(clip).toHaveAttribute("aria-pressed", "true");
      await expect(card).toBeVisible();
      await expectSeparate(card, corner);

      await expect(script).toHaveAttribute("aria-pressed", "true");
      await script.tap();
      await expect(script).toHaveAttribute("aria-pressed", "false");
      await expect(card).toBeVisible();
      await expectSeparate(card, corner);

      await close.focus();
      await expect(close).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(card).toBeHidden();
      await expect(inspect).toBeFocused();
    },
    undefined,
    createScriptRecordingIdentityProject,
  );
});
