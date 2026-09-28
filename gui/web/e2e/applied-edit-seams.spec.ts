import { expect, test } from "@playwright/test";
import { postDocumentCommand, waiveRefineGate } from "./documentCommand";
import { e2eProjectPath } from "./env";

test.describe("Applied-edit seam ticks", () => {
  test("ripple deletes project to narrow seam ticks and never widen the scroll range", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const lanes = page.locator(".lane-row");
    await expect(lanes.first().locator(".clip-block")).toHaveCount(1);
    const scroll = page.locator(".timeline-scroll");
    const base = await scroll.evaluate((el) => el.scrollWidth);

    const command = (type: string, payload: Record<string, unknown>) =>
      postDocumentCommand(page, "e2e-applied-seams", type, payload);
    const waive = () => waiveRefineGate(page, "e2e applied seams");

    try {
      await waive();
      await command("RippleDeleteRange", { start: 40, end: 50 });
      await waive();
      await command("RippleDeleteRange", { start: 5, end: 15 });

      await expect(lanes.first().locator(".clip-block")).toHaveCount(3);
      const ticks = lanes.first().locator(".applied-tick--seam");
      await expect(ticks).toHaveCount(2);
      const count = await ticks.count();
      for (let i = 0; i < count; i += 1) {
        const box = await ticks.nth(i).boundingBox();
        expect(box?.width ?? 0).toBeLessThanOrEqual(3);
      }
      const after = await scroll.evaluate((el) => el.scrollWidth);
      expect(after).toBeLessThanOrEqual(base + 1);
    } finally {
      await command("UndoHistory", { rerender: false });
      await command("UndoHistory", { rerender: false });
      await expect(lanes.first().locator(".clip-block")).toHaveCount(1);
    }
  });
});
