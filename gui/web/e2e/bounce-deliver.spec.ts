import { expect, test } from "@playwright/test";
import { bouncedWavs } from "./exportFiles";
import { withShareableProject } from "./shareableProject";
import { deliverPage, goToStage, startBounce } from "./stageNav";

test("Bounce on Deliver writes a WAV, says so, and the shortcut brings it into view", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await goToStage(page, "edit");
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
