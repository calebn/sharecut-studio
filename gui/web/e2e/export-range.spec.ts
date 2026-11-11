import { expect, type Page, test } from "@playwright/test";
import { bouncedWavs } from "./exportFiles";
import { withShareableProject } from "./shareableProject";
import { goToStage, openProject, selectRangeSec, stageTab } from "./stageNav";

const actionBar = (page: Page) =>
  page.getByRole("group", { name: /^(Selection|Edit) actions$/ });
const toast = (page: Page) => page.locator(".ui-toast-region--app .ui-toast");

test("Export on a range writes a WAV in place and the toast offers Download", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await selectRangeSec(page, "1", "3");
    await actionBar(page)
      .getByRole("button", { name: "Export", exact: true })
      .click();

    await expect(toast(page)).toContainText(
      "Exported 0:01–0:03 (full mix) as WAV",
      { timeout: 60_000 },
    );
    await expect(
      toast(page).getByRole("button", { name: "Download" }),
    ).toBeVisible();
    await expect(stageTab(page, "edit")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect.poll(() => bouncedWavs(projectPath)).toHaveLength(1);

    await goToStage(page, "deliver");
    const group = page
      .getByRole("heading", { name: "Exports of a selection" })
      .locator("..");
    await expect(group.getByText("Unmastered export")).toBeVisible();
  });
});

test("the Export options choose the source and add an MP3", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await selectRangeSec(page, "1", "3");
    await actionBar(page)
      .getByRole("button", { name: "Export options", exact: true })
      .click();
    const options = page.getByRole("dialog", { name: "Export options" });
    await expect(
      options.getByRole("button", { name: "Soloed" }),
    ).toBeDisabled();
    await options.getByRole("button", { name: "Also MP3" }).click();
    await page.keyboard.press("Escape");
    await actionBar(page)
      .getByRole("button", { name: "Export", exact: true })
      .click();

    await expect(toast(page)).toContainText(
      "Exported 0:01–0:03 (full mix) as WAV and MP3",
      { timeout: 60_000 },
    );
    await expect.poll(() => bouncedWavs(projectPath)).toHaveLength(1);
  });
});
