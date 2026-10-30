import { expect, test } from "@playwright/test";
import { LONG_PRESS_MS } from "../src/hooks/gestureConstants";
import { openHostProject } from "./overlayReachability";
import { inspectSelection, inspectSelectionByKey } from "./stageNav";
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
    await inspectSelection(page);
    await expect(page.locator(".bottom-sheet")).toBeVisible();
  });

  test(`a word tapped on a ${tablet.name} tablet is one range and opens the selection sheet`, async ({
    page,
  }) => {
    await page.setViewportSize(tablet);
    await openHostProject(page);
    const list = await openTranscriptPanel(page);
    const word = list.locator(".sys-script-word").nth(3);
    await word.click();
    await expect(list.locator(".sys-script-word[data-selected]")).toHaveCount(
      1,
    );
    await inspectSelectionByKey(page);
    await expect(page.locator(".bottom-sheet")).toBeVisible();
  });
}

const IPADS = [
  { name: "portrait", width: 820, height: 1180 },
  { name: "landscape", width: 1180, height: 820 },
] as const;

for (const ipad of IPADS) {
  test(`a clip long press on a ${ipad.name} iPad leaves the pressed clip in view above the sheet`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize(ipad);
    await page.clock.install();
    await openHostProject(page);
    const clip = page.locator(".lane-row .clip-block").first();
    await clip.scrollIntoViewIfNeeded();
    const box = await clip.boundingBox();
    expect(box).toBeTruthy();
    const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...point, id: 1 }],
    });
    await page.clock.runFor(LONG_PRESS_MS + 150);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(page.locator(".clip-block.selected").first()).toBeVisible();
    await inspectSelection(page);
    const sheet = page.locator(".bottom-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveClass(/bottom-sheet--compact/);
    await expect
      .poll(async () => {
        const selected = await page
          .locator(".clip-block.selected")
          .first()
          .boundingBox();
        const covering = await sheet.boundingBox();
        return selected && covering
          ? covering.y - (selected.y + selected.height)
          : null;
      })
      .toBeGreaterThanOrEqual(0);
  });
}
