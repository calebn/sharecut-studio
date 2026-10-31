import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openProject } from "./stageNav";
import { openScript, SCRIPT_SELECTED, SCRIPT_WORD } from "./transcriptEdit";

test("Shift-click on another speaker selects the range on both tracks", async ({
  page,
}, testInfo) => {
  await openProject(page, e2eProjectPath);
  const list = await openScript(page);
  const words = list.locator(SCRIPT_WORD);
  const tracks = await words.evaluateAll((chips) => [
    ...new Set(
      chips.map((chip) => chip.getAttribute("data-word-key")?.split(":")[0]),
    ),
  ]);
  expect(tracks).toHaveLength(2);
  const start = list
    .locator(`${SCRIPT_WORD}[data-word-key^="${tracks[0]}:"]`)
    .nth(4);
  const target = list
    .locator(`${SCRIPT_WORD}[data-word-key^="${tracks[1]}:"]`)
    .nth(1);
  const overlay = (track: string | null | undefined) =>
    page.locator(`.lane-row[data-track-id="${track}"] .range-overlay`);
  await start.click();
  await expect(list.locator(SCRIPT_SELECTED)).toHaveCount(1);
  await target.click({ modifiers: ["Shift"] });
  // A range across speakers covers that time on both tracks.
  await expect(overlay(tracks[0])).toBeVisible();
  await expect(overlay(tracks[1])).toBeVisible();
  const dragEnd = list
    .locator(`${SCRIPT_WORD}[data-word-key^="${tracks[0]}:"]`)
    .nth(5);
  await start.hover();
  await page.mouse.down();
  await dragEnd.hover();
  await expect(list.locator(SCRIPT_SELECTED)).toHaveCount(2);
  // The floating Selection actions bar covers the words; release over the header.
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await target.click({ modifiers: ["Shift"] });
  await expect(overlay(tracks[0])).toBeVisible();
  await expect(overlay(tracks[1])).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("cross-speaker-range.png"),
  });
  await testInfo.attach("cross-speaker range", {
    path: testInfo.outputPath("cross-speaker-range.png"),
    contentType: "image/png",
  });
});
