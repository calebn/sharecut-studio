import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openProject } from "./stageNav";
import { openTranscriptPanel } from "./transcriptEdit";

test("Shift-click on another speaker starts a range on that track", async ({
  page,
}, testInfo) => {
  await openProject(page, e2eProjectPath);
  const list = await openTranscriptPanel(page);
  await page.getByRole("button", { name: /^Select:/ }).click();
  const words = list.locator("[data-transcript-word][data-track-id]");
  const tracks = await words.evaluateAll((chips) => [
    ...new Set(chips.map((chip) => chip.getAttribute("data-track-id"))),
  ]);
  expect(tracks).toHaveLength(2);
  const start = list
    .locator(`[data-transcript-word][data-track-id="${tracks[0]}"]`)
    .nth(4);
  const target = list
    .locator(`[data-transcript-word][data-track-id="${tracks[1]}"]`)
    .nth(1);
  await start.click();
  await target.click({ modifiers: ["Shift"] });
  await expect(list.locator(".utterance-word.selected")).toHaveCount(1);
  await expect(target).toHaveClass(/selected/);
  const dragEnd = list
    .locator(`[data-transcript-word][data-track-id="${tracks[0]}"]`)
    .nth(5);
  await start.hover();
  await page.mouse.down();
  await dragEnd.hover();
  await expect(list.locator(".utterance-word.selected")).toHaveCount(2);
  // The floating Selection actions bar now covers the mode hint; release over the header.
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await target.click({ modifiers: ["Shift"] });
  await expect(list.locator(".utterance-word.selected")).toHaveCount(1);
  await expect(target).toHaveClass(/selected/);
  await page.screenshot({
    path: testInfo.outputPath("cross-speaker-range.png"),
  });
  await testInfo.attach("cross-speaker range", {
    path: testInfo.outputPath("cross-speaker-range.png"),
    contentType: "image/png",
  });
});
