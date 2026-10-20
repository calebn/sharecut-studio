import { expect, test } from "@playwright/test";
import { openHostProject } from "./overlayReachability";
import { openTranscriptPanel } from "./transcriptEdit";

test.use({ hasTouch: true });

const TABLETS = [
  { name: "portrait", width: 834, height: 1194 },
  { name: "landscape", width: 1194, height: 834 },
] as const;

for (const tablet of TABLETS) {
  test(`a clip selected on a ${tablet.name} tablet opens the selection sheet`, async ({
    page,
  }) => {
    await page.setViewportSize(tablet);
    await openHostProject(page);
    await page.locator(".lane-row .clip-block").first().click();
    await expect(page.locator(".clip-block.selected").first()).toBeVisible();
    await expect(page.locator(".bottom-sheet")).toBeVisible();
  });

  test(`a word tapped on a ${tablet.name} tablet is one range and opens the selection sheet`, async ({
    page,
  }) => {
    await page.setViewportSize(tablet);
    await openHostProject(page);
    const list = await openTranscriptPanel(page);
    await page.getByRole("button", { name: /^Select:/ }).click();
    const word = list.locator("[data-transcript-word][data-track-id]").nth(3);
    await word.click();
    await expect(list.locator(".utterance-word.selected")).toHaveCount(1);
    await expect(page.locator(".bottom-sheet")).toBeVisible();
  });
}
