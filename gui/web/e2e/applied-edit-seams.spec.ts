import { expect, test } from "@playwright/test";
import {
  postDocumentCommand,
  postHistoryMove,
  waiveRefineGate,
} from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openProject } from "./stageNav";

test.describe("Applied-edit seam marks", () => {
  test("ripple deletes draw selectable seam marks and never widen the scroll range", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
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
      await command("CutRange", {
        start: 40,
        end: 50,
        mode: "ripple",
      });
      await waive();
      await command("CutRange", {
        start: 5,
        end: 15,
        mode: "ripple",
      });

      await expect(lanes.first().locator(".clip-block")).toHaveCount(3);
      const seams = lanes.first().locator(".applied-seam .sys-seam-hit");
      await expect(seams).toHaveCount(2);
      await seams.first().click();
      await expect(seams.first()).toHaveAttribute("aria-pressed", "true");
      const after = await scroll.evaluate((el) => el.scrollWidth);
      expect(after).toBeLessThanOrEqual(base + 1);
    } finally {
      await postHistoryMove(page, "e2e-applied-seams", "UndoHistory");
      await postHistoryMove(page, "e2e-applied-seams", "UndoHistory");
      await expect(lanes.first().locator(".clip-block")).toHaveCount(1);
    }
  });
});
