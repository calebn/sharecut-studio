import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { inspectSelection, openProject, phone } from "./stageNav";

test.use({ hasTouch: true });

test("rotating a phone with the Inspector open keeps the focused field on screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openProject(page, e2eProjectPath);
  await phone.showTimeline(page);
  await page.locator(".lane-row .clip-block").first().click();
  await inspectSelection(page);
  await page.getByRole("button", { name: "Expand to half height" }).click();
  const field = page.getByLabel("Fade out ms");
  await expect(field).toBeAttached();
  await field.focus();
  const onScreen = async () => {
    const box = await field.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) return false;
    return (
      box.y >= 0 &&
      box.y + box.height <= viewport.height &&
      box.x >= 0 &&
      box.x + box.width <= viewport.width
    );
  };
  await expect.poll(onScreen).toBe(true);
  for (const [size, column] of [
    [{ width: 667, height: 375 }, true],
    [{ width: 375, height: 667 }, false],
  ] as const) {
    await page.setViewportSize(size);
    await expect(page.locator(".bottom-sheet--column")).toHaveCount(
      column ? 1 : 0,
    );
    await expect(field).toBeFocused();
    await expect.poll(onScreen).toBe(true);
  }
});
