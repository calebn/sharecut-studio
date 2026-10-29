import { expect, test } from "@playwright/test";
import { bouncedWavs } from "./exportFiles";
import { expectFitsViewport } from "./overlayReachability";
import { withShareableProject } from "./shareableProject";
import { deliverPage, openProject, startBounce } from "./stageNav";

test.use({ hasTouch: true, isMobile: true });

function expectTouchHeight(height: number, layoutHeight: number): void {
  expect(layoutHeight).toBeGreaterThanOrEqual(44);
  // Translated DOM rectangles can report 43.999996px for a 44px layout box.
  expect(height).toBeGreaterThanOrEqual(44 - 0.001);
}

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
    const options = deliver
      .getByRole("group", { name: "Source" })
      .getByRole("button")
      .or(
        deliver
          .getByRole("group", { name: "Bounce options" })
          .getByRole("button"),
      );
    const rows = await options.evaluateAll((els) =>
      els.map((el) => ({
        height: el.getBoundingClientRect().height,
        layoutHeight: el instanceof HTMLElement ? el.offsetHeight : 0,
      })),
    );
    // Three sources, the session region and the MP3 toggle.
    expect(rows).toHaveLength(5);
    for (const row of rows) expectTouchHeight(row.height, row.layoutHeight);
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
