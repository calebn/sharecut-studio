import { expect, test } from "@playwright/test";
import { bouncedWavs } from "./exportFiles";
import { withShareableProject } from "./shareableProject";
import { deliverPage, goToStage, openProject, startBounce } from "./stageNav";

test("Bounce on Deliver writes a WAV, says so, and the shortcut brings it into view", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await page.keyboard.press("ControlOrMeta+Shift+b");
    const deliver = deliverPage(page);
    const bounce = deliver.getByRole("button", { name: "Bounce", exact: true });
    await expect(bounce).toBeFocused();

    await goToStage(page, "edit");
    await startBounce(page);
    await expect(deliver).toContainText("Bounced 1 file(s) to export/bounces/");
    await expect(deliver).not.toContainText("Bounce failed");
    await expect.poll(() => bouncedWavs(projectPath)).toHaveLength(1);
  });
});

test("a refused Bounce names the failure, and Try again bounces", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    let refuse = true;
    await page.route("**/api/export/bounce", async (route) => {
      if (refuse) await route.abort();
      else await route.continue();
    });
    await startBounce(page);
    const deliver = deliverPage(page);
    await expect(deliver.getByText("Bounce failed")).toBeVisible();
    expect(await bouncedWavs(projectPath)).toHaveLength(0);

    refuse = false;
    await deliver.getByRole("button", { name: "Try again" }).click();
    await deliver.getByRole("button", { name: "Bounce", exact: true }).click();
    await expect(deliver).toContainText("Bounced 1 file(s) to export/bounces/");
    await expect.poll(() => bouncedWavs(projectPath)).toHaveLength(1);
  });
});
