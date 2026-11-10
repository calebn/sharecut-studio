import { expect } from "@playwright/test";
import { test } from "../e2e/interactionEvidence";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openProject } from "../e2e/stageNav";

test.use({ hasTouch: true, viewport: { width: 360, height: 640 } });

test("360x640 phone Edit overview paints one focus ring on the strip, not on its touch box", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await openPhoneTimeline(page);
    const slider = page.getByRole("slider", {
      name: "Episode overview",
      exact: true,
    });
    await slider.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(slider).toBeFocused();
    const rings = await slider.evaluate((root) => {
      const face = root.querySelector(".sys-overview-face");
      const ring = (el: Element | null) => {
        const style = el ? getComputedStyle(el) : null;
        return style?.outlineStyle === "none"
          ? "none"
          : `${style?.outlineStyle} ${style?.outlineWidth}`;
      };
      return {
        root: ring(root),
        face: ring(face),
        height: root.getBoundingClientRect().height,
      };
    });
    expect(rings.root).toBe("none");
    expect(rings.face).toBe("solid 2px");
    expect(rings.height).toBeGreaterThanOrEqual(44);
  });
});
