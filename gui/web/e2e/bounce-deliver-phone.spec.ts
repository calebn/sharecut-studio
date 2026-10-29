import { expect, test } from "@playwright/test";
import { bouncedWavs } from "./exportFiles";
import { expectFitsViewport } from "./overlayReachability";
import { withShareableProject } from "./shareableProject";
import { deliverPage, openProject, startBounce } from "./stageNav";

test("phone 390x844: Bounce starts, shows why Cancel waits, and lists the file it wrote", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/api/export/bounce", async (route) => {
      await held;
      await route.continue();
    });
    await startBounce(page);
    const deliver = deliverPage(page);
    await expect(deliver.getByText(/Starting bounce…/)).toBeVisible();
    const cancel = deliver.getByRole("button", { name: "Cancel" });
    await expectFitsViewport(page, cancel);
    await expectFitsViewport(page, deliver.getByText(/still starting/i));
    release();
    await expect(deliver).toContainText("Bounced 1 file(s) to export/bounces/");
    await expectFitsViewport(
      page,
      deliver.getByText("Bounced", { exact: true }),
    );
    await expect.poll(() => bouncedWavs(projectPath)).toHaveLength(1);
  });
});
