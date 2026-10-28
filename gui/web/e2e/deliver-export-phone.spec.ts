import { expect, test } from "@playwright/test";
import { expectFitsViewport } from "./overlayReachability";
import { withShareableProject } from "./shareableProject";
import { deliverPage, openProject, startExport } from "./stageNav";

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test(`phone ${viewport.width}x${viewport.height}: the starting export and its cancel reason are on screen`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      await page.route("**/api/export/deliverables", async (route) => {
        await gate;
        await route.abort();
      });
      try {
        await startExport(page);
        const deliver = deliverPage(page);
        await expect(deliver.getByText(/Starting export…/)).toBeVisible();
        await expectFitsViewport(
          page,
          deliver.getByRole("button", { name: "Cancel" }),
        );
        await expectFitsViewport(page, deliver.getByText(/still starting/i));
      } finally {
        release();
      }
    });
  });
}
