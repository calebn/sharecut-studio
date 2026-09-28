import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test.describe("Timeline fade curves", () => {
  test("drags a hover-revealed corner handle into a drawn fade", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const clip = page.locator(".lane-row").first().locator(".clip-block");
    await expect(clip).toHaveCount(1);
    const corner = clip.locator("button.fade-corner.in");
    const lines = clip.locator(".clip-fade-line");
    await expect(lines).toHaveCount(0);
    // Zero-length fade: transparent and click-through until the clip is hovered.
    await page.mouse.move(0, 0);
    await expect(corner).toHaveCSS("opacity", "0");
    await expect(corner).toHaveCSS("pointer-events", "none");
    await clip.hover();
    await expect(corner).toHaveCSS("opacity", "1");
    await expect(corner).toHaveCSS("pointer-events", "auto");
    await expect(clip.locator(".trim-handle.in")).toHaveCSS("opacity", "1");
    try {
      const box = await corner.boundingBox();
      if (!box) throw new Error("fade corner has no box");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 40, y, { steps: 5 });
      await expect(clip.locator(".fade-readout.in")).toHaveText(/^\d+ ms$/);
      await page.mouse.up();
      await expect(lines).toHaveCount(1);
      await expect(corner).not.toHaveClass(/\bzero\b/);
      await expectPageAxeClean(page, ".lane-row .clip-block");
    } finally {
      // Leave the shared live E2E project as later specs expect it; undo only
      // our own fade so a failed drag never undoes another spec's edit.
      if ((await lines.count()) > 0) {
        await page.keyboard.press("Escape");
        await page.keyboard.press("ControlOrMeta+Z");
        await expect(lines).toHaveCount(0);
      }
    }
  });
});
